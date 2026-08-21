(() => {
  "use strict";

  const root = document.documentElement;
  const viewport = window.visualViewport;
  const isIOS =
    /\b(iPad|iPhone|iPod)\b/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIPad =
    /\biPad\b/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIPadChrome = /\bCriOS\//.test(navigator.userAgent) && isIPad;
  let lastViewportMetrics = "";
  let viewportFrame = 0;
  let viewportTimers = [];
  let dispatchingResize = false;

  function notifyTerminalResize() {
    dispatchingResize = true;
    window.dispatchEvent(new Event("resize"));
    dispatchingResize = false;
  }

  function updateViewport(forceFit = false) {
    const layoutHeight = window.innerHeight;
    const visualHeight = viewport ? viewport.height : layoutHeight;
    // Ignore iPad Chrome's small stale focus inset after the keyboard closes,
    // while retaining the smaller visual viewport when a keyboard is visible.
    const useLayoutViewport =
      !viewport ||
      (isIPadChrome &&
        layoutHeight > visualHeight &&
        layoutHeight - visualHeight < layoutHeight / 4);
    const height = Math.ceil(useLayoutViewport ? layoutHeight : visualHeight);
    const width = Math.ceil(useLayoutViewport || !viewport ? window.innerWidth : viewport.width);
    const top = Math.round(
      viewport && !useLayoutViewport
        ? Math.max(viewport.offsetTop, viewport.pageTop - window.scrollY, 0)
        : 0,
    );
    const left = Math.round(
      viewport && !useLayoutViewport
        ? Math.max(viewport.offsetLeft, viewport.pageLeft - window.scrollX, 0)
        : 0,
    );
    const metrics = `${width}:${height}:${left}:${top}`;
    if (metrics !== lastViewportMetrics) {
      lastViewportMetrics = metrics;
      root.style.setProperty("--herdr-web-viewport-height", `${height}px`);
      root.style.setProperty("--herdr-web-viewport-width", `${width}px`);
      root.style.setProperty("--herdr-web-viewport-top", `${top}px`);
      root.style.setProperty("--herdr-web-viewport-left", `${left}px`);
      forceFit = true;
    }
    if (forceFit) notifyTerminalResize();
  }

  function scheduleViewportUpdate() {
    if (viewportFrame) cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      updateViewport(true);
    });
    for (const timer of viewportTimers) clearTimeout(timer);
    viewportTimers = [80, 250, 500].map((delay) =>
      window.setTimeout(() => updateViewport(true), delay),
    );
  }

  if (viewport) {
    viewport.addEventListener("resize", scheduleViewportUpdate, { passive: true });
    viewport.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
    viewport.addEventListener("scrollend", scheduleViewportUpdate, { passive: true });
  }
  window.addEventListener(
    "resize",
    () => {
      if (!dispatchingResize) scheduleViewportUpdate();
    },
    { passive: true },
  );
  window.addEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
  document.addEventListener("focusin", scheduleViewportUpdate, { passive: true });
  document.addEventListener("focusout", scheduleViewportUpdate, { passive: true });
  updateViewport(true);

  let pendingIOSPunctuation = null;

  function isIOSVirtualPunctuation(event) {
    return (
      isIOS &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.inputType === "insertText" &&
      !!event.data &&
      /^\p{P}+$/u.test(event.data) &&
      event.target?.classList?.contains("xterm-helper-textarea") &&
      typeof window.term?.input === "function"
    );
  }

  function sendIOSPunctuation(data) {
    window.term.input(data, true);
  }

  document.addEventListener(
    "beforeinput",
    (event) => {
      // xterm.js #5835: iOS exposes virtual Chinese punctuation here, but its
      // keyCode 229 path can drop the corresponding terminal input.
      if (!isIOSVirtualPunctuation(event)) return;

      const target = event.target;
      pendingIOSPunctuation = {
        data: event.data,
        selectionEnd: target.selectionEnd,
        selectionStart: target.selectionStart,
        target,
        value: target.value,
      };
      event.stopImmediatePropagation();
      if (event.cancelable) {
        event.preventDefault();
        pendingIOSPunctuation = null;
        sendIOSPunctuation(event.data);
      }
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "input",
    (event) => {
      const pending = pendingIOSPunctuation;
      if (
        !pending ||
        event.target !== pending.target ||
        event.inputType !== "insertText" ||
        event.data !== pending.data
      ) {
        return;
      }

      pendingIOSPunctuation = null;
      event.stopImmediatePropagation();
      pending.target.value = pending.value;
      if (typeof pending.target.setSelectionRange === "function") {
        pending.target.setSelectionRange(pending.selectionStart, pending.selectionEnd);
      }
      sendIOSPunctuation(pending.data);
    },
    { capture: true },
  );

  document.addEventListener("contextmenu", (event) => {
    // Keep the terminal's own menu suppressed (two-finger tap is right-click),
    // but allow the native long-press menu on the toolbar's paste input: on
    // LAN HTTP origins the Clipboard API is unavailable, so the system menu
    // is the only way to paste on phones.
    const target = event.target;
    if (
      typeof target?.closest === "function" &&
      target.closest(".herdr-web-input-toolbar")
    ) {
      return;
    }
    event.preventDefault();
  });

  if (!(navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches)) {
    return;
  }

  const holdDelay = 450;
  const dragThreshold = 6;
  const twoFingerTapDelay = 400;
  const twoFingerTapDistance = 12;

  function selectedTerminalText() {
    if (typeof window.term?.getSelection === "function") {
      const selection = window.term.getSelection();
      if (selection) return selection;
    }
    return document.getSelection?.()?.toString() || "";
  }

  function legacyCopyText(text) {
    const previousFocus = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.border = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    let copied = false;
    textarea.addEventListener("copy", (event) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      copied = true;
    });
    try {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand("copy") || copied;
    } finally {
      textarea.remove();
      if (previousFocus?.classList?.contains("xterm-helper-textarea")) {
        previousFocus.focus({ preventScroll: true });
      }
    }
    return copied;
  }

  function offerManualCopy(text) {
    if (typeof window.prompt !== "function") return false;
    window.prompt("Copy selected text", text);
    return true;
  }

  async function copyText(text) {
    if (!text) return false;
    if (window.isSecureContext && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // LAN HTTP and browser permission policies can reject Clipboard API.
      }
    }
    return legacyCopyText(text) || offerManualCopy(text);
  }

  function sendTerminalInput(data) {
    if (!data || typeof window.term?.input !== "function") return;
    window.term.input(data, true);
    window.term.focus?.();
  }

  function pasteTerminalText(text) {
    if (typeof window.term?.paste === "function") {
      window.term.paste(text);
      window.term.focus?.();
      return;
    }
    sendTerminalInput(text);
  }

  function createInputToolbar(terminal) {
    const toolbar = document.createElement("div");
    toolbar.className = "herdr-web-input-toolbar";
    toolbar.hidden = true;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Terminal input controls");

    const actionIcons = {
      enter:
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5v6a5 5 0 0 1-5 5H5"/><path d="m9 12-4 4 4 4"/></svg>',
      escape:
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    };

    function appendButton(parent, action, name) {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = actionIcons[name];
      button.dataset.action = name;
      button.setAttribute("aria-label", name === "escape" ? "Escape" : "Enter");
      button.setAttribute("title", name === "escape" ? "Escape" : "Enter");
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      });
      parent.appendChild(button);
      return button;
    }

    const pasteInput = document.createElement("textarea");
    pasteInput.className = "herdr-web-paste-input";
    pasteInput.rows = 1;
    pasteInput.placeholder = "Paste or type";
    pasteInput.setAttribute("aria-label", "Text to paste into terminal");
    pasteInput.setAttribute("enterkeyhint", "send");
    toolbar.appendChild(pasteInput);

    const inputMinHeight = 72;
    const inputMaxHeight = 128;
    const toolbarPaddingHeight = 8;
    let toolbarFitFrame = 0;

    function resizePasteInput() {
      pasteInput.style.height = `${inputMinHeight}px`;
      pasteInput.style.overflowY = "hidden";
      const contentHeight = Number(pasteInput.scrollHeight) || inputMinHeight;
      const inputHeight = Math.min(inputMaxHeight, Math.max(inputMinHeight, contentHeight));
      pasteInput.style.height = `${inputHeight}px`;
      pasteInput.style.overflowY = contentHeight > inputMaxHeight ? "auto" : "hidden";
      root.style.setProperty(
        "--herdr-web-toolbar-height",
        `${inputHeight + toolbarPaddingHeight}px`,
      );
      if (toolbar.hidden) return;
      if (toolbarFitFrame) cancelAnimationFrame(toolbarFitFrame);
      toolbarFitFrame = requestAnimationFrame(() => {
        toolbarFitFrame = 0;
        notifyTerminalResize();
      });
    }

    pasteInput.addEventListener("input", resizePasteInput);

    function submitPasteInput() {
      if (pasteInput.value !== "") {
        const text = pasteInput.value;
        pasteTerminalText(text);
        sendTerminalInput("\r");
        pasteInput.value = "";
        resizePasteInput();
        return;
      }
      sendTerminalInput("\r");
    }

    const actions = document.createElement("div");
    actions.className = "herdr-web-toolbar-actions";
    appendButton(actions, () => sendTerminalInput("\x1b"), "escape");
    appendButton(actions, submitPasteInput, "enter");
    toolbar.appendChild(actions);
    document.body.appendChild(toolbar);
    resizePasteInput();

    function setVisible(visible) {
      if (toolbar.hidden === !visible) return;
      toolbar.hidden = !visible;
      root.classList.toggle("herdr-web-toolbar-visible", visible);
      scheduleViewportUpdate();
    }

    document.addEventListener("focusin", (event) => {
      if (toolbar.contains(event.target)) {
        setVisible(true);
        return;
      }
      if (
        event.target?.classList?.contains("xterm-helper-textarea") &&
        terminal.contains(event.target)
      ) {
        setVisible(true);
      }
    });
    document.addEventListener("focusout", () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        setVisible(
          toolbar.contains(active) ||
            (!!active?.classList?.contains("xterm-helper-textarea") &&
              terminal.contains(active)),
        );
      }, 0);
    });
    const active = document.activeElement;
    if (active?.classList?.contains("xterm-helper-textarea") && terminal.contains(active)) {
      setVisible(true);
    }
  }

  function attachTouchControls(terminal) {
    if (terminal.dataset.herdrWebTouch === "ready") return;
    terminal.dataset.herdrWebTouch = "ready";
    scheduleViewportUpdate();

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "herdr-web-copy-button";
    copyButton.textContent = "Copy";
    copyButton.hidden = true;
    copyButton.setAttribute("aria-label", "Copy terminal selection");
    terminal.appendChild(copyButton);

    let copySelectionText = "";
    function captureCopySelection() {
      const text = selectedTerminalText();
      if (text) copySelectionText = text;
      return text;
    }

    for (const eventName of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "mousedown"]) {
      copyButton.addEventListener(eventName, (event) => {
        if (eventName === "touchstart" || eventName === "pointerdown" || eventName === "mousedown") {
          captureCopySelection();
        }
        event.stopPropagation();
      });
    }
    copyButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = copySelectionText || captureCopySelection();
      if (!text) {
        copyButton.textContent = "No selection";
        return;
      }
      copyButton.disabled = true;
      void copyText(text).then((copied) => {
        copyButton.disabled = false;
        copyButton.textContent = copied ? "Copy" : "Copy unavailable";
        copyButton.hidden = copied;
        if (copied) copySelectionText = "";
      });
    });
    window.term?.onSelectionChange?.(captureCopySelection);

    createInputToolbar(terminal);

    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;
    let dragging = false;
    let animation = 0;
    let holdTimer = 0;
    let activeTouches = 0;
    let selecting = false;
    let selectionMoved = false;
    let twoFinger = false;
    let twoFingerEligible = false;
    let twoFingerSent = false;
    let twoFingerStartTime = 0;
    let twoFingerStartX = 0;
    let twoFingerStartY = 0;
    let twoFingerX = 0;
    let twoFingerY = 0;
    let twoFingerMovement = 0;

    function stopInertia() {
      if (animation) cancelAnimationFrame(animation);
      animation = 0;
      velocity = 0;
    }

    function cancelHold() {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = 0;
    }

    function mouseTarget(clientX, clientY) {
      const target = document.elementFromPoint(clientX, clientY);
      return target && terminal.contains(target) ? target : terminal;
    }

    function sendMouse(type, clientX, clientY, button, buttons, forceSelection = false) {
      mouseTarget(clientX, clientY).dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button,
          buttons,
          detail: type === "mousedown" ? 1 : 0,
          shiftKey: forceSelection,
          view: window,
        }),
      );
    }

    function beginSelection() {
      holdTimer = 0;
      if (activeTouches !== 1 || dragging || twoFinger) return;
      copySelectionText = "";
      selecting = true;
      selectionMoved = false;
      sendMouse("mousedown", startX, startY, 0, 1, true);
    }

    function finishSelection(clientX, clientY) {
      sendMouse("mouseup", clientX, clientY, 0, 0, true);
      selecting = false;
      captureCopySelection();
      if (selectionMoved) copyButton.hidden = false;
    }

    function touchCenter(touches) {
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    }

    function startTwoFingerTap(event) {
      cancelHold();
      stopInertia();
      if (selecting) finishSelection(lastX, lastY);
      dragging = false;
      copyButton.hidden = true;
      const center = touchCenter(event.touches);
      twoFinger = true;
      twoFingerEligible = true;
      twoFingerSent = false;
      twoFingerStartTime = performance.now();
      twoFingerStartX = twoFingerX = center.x;
      twoFingerStartY = twoFingerY = center.y;
      twoFingerMovement = 0;
    }

    function sendRightClick() {
      sendMouse("mousedown", twoFingerX, twoFingerY, 2, 2);
      sendMouse("mouseup", twoFingerX, twoFingerY, 2, 0);
    }

    function sendWheel(deltaY, clientX, clientY) {
      terminal.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          deltaMode: 0,
          deltaY,
          view: window,
        }),
      );
    }

    terminal.addEventListener(
      "touchstart",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        copyButton.hidden = true;
        if (event.touches.length === 2) {
          startTwoFingerTap(event);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.touches.length !== 1) {
          cancelHold();
          twoFingerEligible = false;
          return;
        }
        stopInertia();
        const touch = event.touches[0];
        startX = lastX = touch.clientX;
        startY = lastY = touch.clientY;
        lastTime = performance.now();
        dragging = false;
        selectionMoved = false;
        cancelHold();
        holdTimer = window.setTimeout(beginSelection, holdDelay);
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchmove",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        if (twoFinger) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.touches.length !== 2) {
            twoFingerEligible = false;
            return;
          }
          const center = touchCenter(event.touches);
          twoFingerX = center.x;
          twoFingerY = center.y;
          twoFingerMovement = Math.max(
            twoFingerMovement,
            Math.hypot(center.x - twoFingerStartX, center.y - twoFingerStartY),
          );
          return;
        }
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (selecting) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (Math.hypot(touch.clientX - startX, touch.clientY - startY) >= dragThreshold) {
            selectionMoved = true;
          }
          lastX = touch.clientX;
          lastY = touch.clientY;
          sendMouse("mousemove", lastX, lastY, 0, 1, true);
          captureCopySelection();
          return;
        }
        const now = performance.now();
        const deltaY = lastY - touch.clientY;
        if (!dragging && Math.hypot(touch.clientX - startX, touch.clientY - startY) < dragThreshold) {
          return;
        }

        dragging = true;
        cancelHold();
        event.preventDefault();
        event.stopImmediatePropagation();
        sendWheel(deltaY, touch.clientX, touch.clientY);

        const elapsed = Math.max(1, now - lastTime);
        const frameVelocity = (deltaY / elapsed) * 16.67;
        velocity = velocity * 0.65 + frameVelocity * 0.35;
        lastY = touch.clientY;
        lastX = touch.clientX;
        lastTime = now;
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchend",
      (event) => {
        if (event.target === copyButton) return;
        activeTouches = event.touches.length;
        if (twoFinger) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!twoFingerSent && event.touches.length < 2) {
            const elapsed = performance.now() - twoFingerStartTime;
            if (twoFingerEligible && elapsed <= twoFingerTapDelay && twoFingerMovement <= twoFingerTapDistance) {
              sendRightClick();
            }
            twoFingerSent = true;
          }
          if (event.touches.length === 0) {
            twoFinger = false;
            twoFingerEligible = false;
          }
          return;
        }
        cancelHold();
        if (selecting) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const touch = event.changedTouches[0];
          finishSelection(touch ? touch.clientX : lastX, touch ? touch.clientY : lastY);
          return;
        }
        if (!dragging || Math.abs(velocity) < 0.35) return;
        const glide = () => {
          velocity *= 0.92;
          if (Math.abs(velocity) < 0.35) {
            animation = 0;
            return;
          }
          sendWheel(velocity, lastX, lastY);
          animation = requestAnimationFrame(glide);
        };
        animation = requestAnimationFrame(glide);
      },
      { capture: true, passive: false },
    );

    terminal.addEventListener(
      "touchcancel",
      (event) => {
        if (event.target === copyButton) return;
        cancelHold();
        stopInertia();
        activeTouches = 0;
        twoFinger = false;
        twoFingerEligible = false;
        if (selecting) {
          const touch = event.changedTouches[0];
          finishSelection(touch ? touch.clientX : lastX, touch ? touch.clientY : lastY);
        }
      },
      { capture: true, passive: true },
    );
  }

  function findTerminal() {
    const terminal = document.querySelector(".xterm");
    if (!terminal) return false;
    attachTouchControls(terminal);
    return true;
  }

  if (!findTerminal()) {
    const observer = new MutationObserver(() => {
      if (findTerminal()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
