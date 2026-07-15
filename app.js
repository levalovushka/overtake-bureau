(() => {
  const section = document.querySelector(".cases");
  const track = document.querySelector(".cases__track");
  const cursorNav = document.querySelector(".cursor-nav");
  const columnRef = document.querySelector(".hero");
  if (!section || !track || !columnRef) return;

  const realItems = Array.from(track.children);
  const count = realItems.length;
  const startRealIndex = Math.floor(count / 2); // matches the original centered case-3

  const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduceMotion = reduceMotionQuery.matches;
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  const DRAG_THRESHOLD = 6;
  const SNAP_THRESHOLD_RATIO = 0.15;
  // critically damped spring: no scripted duration, motion emerges from the
  // live position + velocity, so it can be retargeted or grabbed at any frame.
  // omega 16 settles visually in ~450ms from rest — close to the old ease-out
  const SPRING_OMEGA = 16;
  // momentum projection (Apple's exponential-decay form, iOS scroll default):
  // a flick coasts as if decelerating 0.998/ms, i.e. velocity * ~0.5s further
  const PROJECTION = 0.998 / (1 - 0.998) / 1000;
  const VELOCITY_WINDOW = 100; // ms of pointer history used for release velocity
  const RELEASE_STALL = 80; // holding still this long before release kills momentum
  const MAX_FLICK = count; // one full loop per gesture is plenty

  const mod = (n, m) => ((n % m) + m) % m;

  function makeClone(item) {
    const clone = item.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    // clones only exist to pad past the real array's start/end for the loop
    // wraparound — they're always off-screen on first paint, so they should
    // never compete for bandwidth with what's actually visible on load
    const img = clone.querySelector("img");
    if (img) img.loading = "lazy";
    const video = clone.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("autoplay");
      video.preload = "none";
    }
    return clone;
  }

  let items = realItems;
  let bufferCount = 0;
  let itemWidth = 0;
  let itemStep = 0;
  let colLeft = 0; // cached: the text column's left edge relative to the section
  let videoObserver = null;

  // the whole slider drives off one continuous number: `pos`, the current
  // position in slide units (2.5 = halfway between the 3rd and 4th real slide).
  // drag writes it directly, the spring integrates it toward `target`, and
  // wrap() rebases it by whole loops — there is no separate "animating" state
  // to lock, which is what makes rapid clicks and mid-flight grabs just work
  let pos = startRealIndex;
  let target = startRealIndex;
  let velocity = 0; // slides per second
  let rafId = null;
  let lastTick = 0;
  let drag = null;

  function syncVideos() {
    if (reduceMotion) {
      videoObserver?.disconnect();
      videoObserver = null;
      for (const item of items) {
        for (const video of item.querySelectorAll("video")) video.pause();
      }
      return;
    }

    if (!videoObserver) {
      videoObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            for (const video of entry.target.querySelectorAll("video")) {
              if (entry.isIntersecting) video.play().catch(() => {});
              else video.pause();
            }
          }
        },
        { root: section, threshold: 0 }
      );
    }

    videoObserver.disconnect();
    for (const item of items) {
      videoObserver.observe(item);
    }
  }

  function render() {
    const x = colLeft - (bufferCount + pos) * itemStep;
    track.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  // shifting everything by a whole loop is invisible: the clones on either end
  // are exact copies of what slides into view — so we can rebase on any frame,
  // even mid-drag or mid-flight. this is what lets a drag run forever in one
  // direction instead of hitting a clamp at the clone boundary
  function wrap() {
    const shift = Math.floor(pos / count) * count;
    if (shift === 0) return;
    pos -= shift;
    target -= shift;
    if (drag) drag.basePos -= shift;
  }

  function tick(now) {
    const dt = Math.min((now - lastTick) / 1000, 0.064);
    lastTick = now;

    if (!drag?.committed) {
      // integrate in ≤8ms substeps: a single big step after a dropped frame
      // (or a background-tab wake) is outside the integrator's stable range
      let remaining = dt;
      while (remaining > 0) {
        const step = Math.min(remaining, 0.008);
        remaining -= step;
        const displacement = pos - target;
        velocity += (-SPRING_OMEGA * SPRING_OMEGA * displacement - 2 * SPRING_OMEGA * velocity) * step;
        pos += velocity * step;
      }
      if (Math.abs(pos - target) < 0.001 && Math.abs(velocity) < 0.01) {
        pos = target;
        velocity = 0;
        wrap();
        render();
        rafId = null;
        return;
      }
    }

    wrap();
    render();
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId !== null) return;
    lastTick = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function retarget(nextTarget) {
    target = nextTarget;
    if (reduceMotion) {
      pos = target;
      velocity = 0;
      wrap();
      render();
      return;
    }
    startLoop();
  }

  function goTo(delta) {
    if (itemStep === 0) return;
    // accumulate on the current destination, not the current position, so
    // rapid clicks queue up: two fast clicks land two slides over
    retarget(Math.round(target) + delta);
  }

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
    // the current slide's left edge always lines up with the text column's
    // left edge (hero/pitch/cta all share it) — so any extra slide width
    // shows up as peek on the right. layout-stable, so measured once here
    colLeft = columnRef.getBoundingClientRect().left - section.getBoundingClientRect().left;
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
    // resizing mid-gesture or mid-flight: land instantly on the slide we
    // were headed to, and drop any in-progress drag — its pixel math is stale
    if (drag) {
      drag = null;
      cursorNav?.classList.remove("is-pressed");
      setDragIconActive(false);
    }
    pos = target = mod(Math.round(target), count);
    velocity = 0;
    render();
    syncVideos();
  }

  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      buildLoop();
    });
  });

  reduceMotionQuery.addEventListener("change", () => {
    reduceMotion = reduceMotionQuery.matches;
    if (reduceMotion) {
      pos = target = Math.round(target);
      velocity = 0;
      wrap();
      render();
    }
    syncVideos();
  });

  // ------ cursor-replacing nav button (desktop hover only) ------

  const prevIcon = cursorNav?.querySelector(".cursor-nav__icon--prev");
  const nextIcon = cursorNav?.querySelector(".cursor-nav__icon--next");
  const dragIcon = cursorNav?.querySelector(".cursor-nav__icon--drag");
  let isLeftSide = null;

  function updateSide(clientX) {
    const rect = section.getBoundingClientRect();
    const nextIsLeftSide = clientX - rect.left < rect.width / 2;
    if (nextIsLeftSide === isLeftSide) return;
    isLeftSide = nextIsLeftSide;
    if (drag?.committed) return; // the drag icon owns the display for now
    prevIcon?.classList.toggle("is-active", isLeftSide);
    nextIcon?.classList.toggle("is-active", !isLeftSide);
  }

  function setDragIconActive(active) {
    dragIcon?.classList.toggle("is-active", active);
    if (active) {
      prevIcon?.classList.remove("is-active");
      nextIcon?.classList.remove("is-active");
    }
  }

  if (canHover && cursorNav) {
    section.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      section.classList.add("is-cursor-nav");
      cursorNav.classList.add("is-visible");
      updateSide(event.clientX);
    });

    section.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      cursorNav.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
      if (!drag?.committed) updateSide(event.clientX);
    });

    section.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      section.classList.remove("is-cursor-nav");
      cursorNav.classList.remove("is-visible", "is-pressed");
      isLeftSide = null;
    });
  }

  // ------ drag / click / flick, one handler for mouse and touch ------

  // Firefox starts a native image drag from a mousedown despite the CSS opt-out
  track.addEventListener("dragstart", (event) => event.preventDefault());

  section.addEventListener("pointerdown", (event) => {
    // ignore secondary buttons (a context-menu swallows the pointerup and
    // would leave the drag stuck) and second fingers mid-gesture; a stale
    // uncommitted press (pointer released outside the section) is replaced
    if (drag?.committed || itemStep === 0 || event.button > 0) return;
    drag = {
      pointerId: event.pointerId,
      mouse: event.pointerType === "mouse",
      startX: event.clientX,
      startY: event.clientY,
      baseX: event.clientX,
      basePos: pos,
      startPos: pos,
      samples: [[event.timeStamp, event.clientX]],
      committed: false,
    };
    // note: the spring is NOT stopped here — an uncommitted press is just a
    // click-in-waiting, and committing mid-flight catches the track wherever
    // it currently is (drag.basePos above), never where it was headed
    if (drag.mouse) cursorNav?.classList.add("is-pressed");
  });

  section.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;

    const samples = drag.samples;
    samples.push([event.timeStamp, event.clientX]);
    while (samples.length > 2 && event.timeStamp - samples[1][0] > VELOCITY_WINDOW) {
      samples.shift();
    }

    if (!drag.committed) {
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (drag.mouse) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD) return;
      } else {
        if (Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) return;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
          drag = null; // vertical gesture: hand off to native scroll
          return;
        }
      }
      drag.committed = true;
      // re-base at the commit point so the track doesn't jump by the
      // threshold distance, and starts exactly under the pointer even if it
      // was grabbed mid-animation
      drag.baseX = event.clientX;
      drag.basePos = pos;
      drag.startPos = pos;
      velocity = 0;
      section.setPointerCapture(event.pointerId);
      if (drag.mouse) setDragIconActive(true);
      startLoop(); // physics is paused while committed; the loop just renders
    }

    pos = drag.basePos + (drag.baseX - event.clientX) / itemStep;
    wrap();
  });

  function releaseVelocity(ended, releaseTime) {
    const samples = ended.samples;
    const last = samples[samples.length - 1];
    // holding still before letting go means "put it down here", not a flick
    if (releaseTime - last[0] > RELEASE_STALL) return 0;
    let ref = null;
    for (let i = samples.length - 2; i >= 0; i--) {
      if (last[0] - samples[i][0] > VELOCITY_WINDOW) break;
      ref = samples[i];
    }
    if (!ref || last[0] - ref[0] < 10) return 0;
    return ((ref[1] - last[1]) / (last[0] - ref[0])) * 1000 / itemStep; // slides/s
  }

  function endDrag(event, cancelled) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const ended = drag;
    drag = null;
    if (ended.mouse) cursorNav?.classList.remove("is-pressed");

    if (!ended.committed) {
      if (ended.mouse && !cancelled) {
        // no real movement: treat it as a click, navigate by side
        const rect = section.getBoundingClientRect();
        goTo(event.clientX - rect.left < rect.width / 2 ? -1 : 1);
      }
      return;
    }

    if (ended.mouse) {
      setDragIconActive(false);
      // setDragIconActive stripped prev/next's is-active without telling
      // isLeftSide, so updateSide would see "no change" and skip re-applying
      // it — force a resync
      isLeftSide = null;
      updateSide(event.clientX);
    }

    const flick = cancelled ? 0 : releaseVelocity(ended, event.timeStamp);
    // snap to the slide nearest to where the momentum would coast to — a hard
    // flick sails past several slides instead of always stopping at ±1
    let next = Math.round(pos + flick * PROJECTION);
    // ...but a slow deliberate drag past the threshold still always advances,
    // even with no momentum to project
    const traveled = pos - ended.startPos;
    const from = Math.round(ended.startPos);
    if (next === from && Math.abs(traveled) > SNAP_THRESHOLD_RATIO) {
      next = from + Math.sign(traveled);
    }
    next = Math.max(Math.round(pos) - MAX_FLICK, Math.min(Math.round(pos) + MAX_FLICK, next));

    // hand the pointer's velocity to the spring so the seam between finger
    // and animation is invisible — overshoot then emerges only from real
    // momentum, never from a scripted bounce
    velocity = flick;
    retarget(next);
  }

  section.addEventListener("pointerup", (event) => endDrag(event, false));
  section.addEventListener("pointercancel", (event) => endDrag(event, true));

  // an uncommitted press is not captured, so releasing it outside the section
  // would never deliver the pointerup — drop it on the way out instead
  section.addEventListener("pointerleave", (event) => {
    if (drag && !drag.committed && event.pointerId === drag.pointerId) {
      drag = null;
      cursorNav?.classList.remove("is-pressed");
    }
  });

  // ------ keyboard ------

  section.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    goTo(event.key === "ArrowLeft" ? -1 : 1);
  });

  buildLoop();
})();
