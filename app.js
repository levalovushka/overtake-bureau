(() => {
  const section = document.querySelector(".cases");
  const track = document.querySelector(".cases__track");
  const cursorNav = document.querySelector(".cursor-nav");
  const columnRef = document.querySelector(".hero");
  if (!section || !track || !columnRef) return;

  // the current slide's left edge always lines up with the text column's
  // left edge (hero/pitch/cta all share it), instead of being centered in
  // the viewport — so any extra slide width shows up as peek on the right
  function columnLeft() {
    return columnRef.getBoundingClientRect().left - section.getBoundingClientRect().left;
  }

  const realItems = Array.from(track.children);
  const count = realItems.length;
  const startRealIndex = Math.floor(count / 2); // matches the original centered case-3

  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SLIDE_DURATION = reduceMotion ? 1 : 550;
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  function makeClone(item) {
    const clone = item.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    // clones only exist to pad past the real array's start/end for the loop
    // wraparound — they're always off-screen on first paint, so they should
    // never compete for bandwidth with what's actually visible on load
    const img = clone.querySelector("img");
    if (img) img.loading = "lazy";
    return clone;
  }

  let items = realItems;
  let bufferCount = 0;
  let index = startRealIndex;
  let realIndex = startRealIndex; // current slide, independent of clone padding
  let itemWidth = 0;
  let itemStep = 0;
  let isAnimating = false;

  // build enough clone padding on each side to cover however many neighbor
  // slides peek into view at the current viewport width, so the track never
  // runs out of content to show while sliding past the real set
  function buildLoop() {
    track.querySelectorAll('[data-clone="true"]').forEach((el) => el.remove());

    const containerWidth = section.getBoundingClientRect().width;
    const rect = realItems[0].getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(track).columnGap || "0");
    itemWidth = rect.width;
    itemStep = itemWidth + gap;
    const colLeft = columnLeft();
    const leftPeek = Math.max(0, colLeft);
    const rightPeek = Math.max(0, containerWidth - colLeft - itemWidth);
    const neededBuffer = Math.max(1, Math.ceil(Math.max(leftPeek, rightPeek) / itemStep) + 1);
    bufferCount = Math.min(count - 1, neededBuffer);

    const prefix = realItems.slice(count - bufferCount).map(makeClone);
    const suffix = realItems.slice(0, bufferCount).map(makeClone);
    for (const clone of [...prefix, ...suffix]) clone.dataset.clone = "true";

    const prefixFrag = document.createDocumentFragment();
    prefix.forEach((clone) => prefixFrag.appendChild(clone));
    track.insertBefore(prefixFrag, track.firstChild);

    const suffixFrag = document.createDocumentFragment();
    suffix.forEach((clone) => suffixFrag.appendChild(clone));
    track.appendChild(suffixFrag);

    items = Array.from(track.children);
    index = bufferCount + realIndex;
    isAnimating = false;
    setPosition(false);
  }

  function computeX() {
    return columnLeft() - index * itemStep;
  }

  function setPosition(animate) {
    const x = computeX();
    track.style.transition = animate
      ? `transform ${SLIDE_DURATION}ms ${EASE_OUT}`
      : "none";
    if (!animate) {
      // force a reflow so the disabled transition is committed before the
      // jump, otherwise some browsers animate it anyway and the loop flashes
      void track.offsetWidth;
    }
    track.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  function goTo(delta) {
    if (isAnimating || itemStep === 0) return;
    isAnimating = true;
    index += delta;
    realIndex = ((realIndex + delta) % count + count) % count;
    setPosition(true);
  }

  track.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "transform") return;
    isAnimating = false;
    if (index < bufferCount) {
      index += count;
      setPosition(false);
    } else if (index >= bufferCount + count) {
      index -= count;
      setPosition(false);
    }
  });

  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      buildLoop();
    });
  });
  buildLoop();

  if (canHover) {
    // desktop: tap zones + a cursor-replacing nav button
    section.addEventListener("click", (event) => {
      const rect = section.getBoundingClientRect();
      const isLeftHalf = event.clientX - rect.left < rect.width / 2;
      goTo(isLeftHalf ? -1 : 1);
    });

    if (cursorNav) {
      const prevIcon = cursorNav.querySelector(".cursor-nav__icon--prev");
      const nextIcon = cursorNav.querySelector(".cursor-nav__icon--next");
      let isLeftSide = null;

      function updateSide(clientX) {
        const rect = section.getBoundingClientRect();
        const nextIsLeftSide = clientX - rect.left < rect.width / 2;
        if (nextIsLeftSide === isLeftSide) return;
        isLeftSide = nextIsLeftSide;
        prevIcon.classList.toggle("is-active", isLeftSide);
        nextIcon.classList.toggle("is-active", !isLeftSide);
      }

      section.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse") return;
        section.classList.add("is-cursor-nav");
        cursorNav.classList.add("is-visible");
        updateSide(event.clientX);
      });

      section.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "mouse") return;
        cursorNav.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
        updateSide(event.clientX);
      });

      section.addEventListener("pointerleave", (event) => {
        if (event.pointerType !== "mouse") return;
        section.classList.remove("is-cursor-nav");
        cursorNav.classList.remove("is-visible", "is-pressed");
        isLeftSide = null;
      });

      section.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "mouse") return;
        cursorNav.classList.add("is-pressed");
      });

      ["pointerup", "pointerleave"].forEach((type) => {
        section.addEventListener(type, () => cursorNav.classList.remove("is-pressed"));
      });
    }
  } else {
    // touch: drag the track directly, snapping to the nearest slide on release
    const DRAG_THRESHOLD = 6;
    const SNAP_THRESHOLD_RATIO = 0.15;
    let drag = null;

    section.style.touchAction = "pan-y";

    section.addEventListener("pointerdown", (event) => {
      if (isAnimating) return;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: computeX(),
        committed: false,
      };
    });

    section.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;

      if (!drag.committed) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          drag = null; // vertical gesture: hand off to native scroll
          return;
        }
        drag.committed = true;
        track.style.transition = "none";
        section.setPointerCapture(event.pointerId);
      }

      // never drag further than the clone padding actually covers
      const maxDelta = Math.max(0, bufferCount * itemStep - 1);
      const clamped = Math.max(-maxDelta, Math.min(maxDelta, deltaX));
      track.style.transform = `translate3d(${drag.baseX + clamped}px, 0, 0)`;
    });

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { committed, startX } = drag;
      const deltaX = event.clientX - startX;
      drag = null;
      if (!committed) return;

      if (Math.abs(deltaX) > itemWidth * SNAP_THRESHOLD_RATIO) {
        goTo(deltaX < 0 ? 1 : -1);
      } else {
        isAnimating = true;
        setPosition(true);
      }
    }

    section.addEventListener("pointerup", endDrag);
    section.addEventListener("pointercancel", endDrag);
  }
})();
