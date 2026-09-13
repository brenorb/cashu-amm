const FLAG_COLORS = ["#ff5c35", "#f6c445", "#2f77a8", "#2a9d75", "#e85d75"];

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function animateLoadingScreen() {
  const screen = document.querySelector("#loading-screen");
  const progress = document.querySelector("#loading-progress-bar");
  const caption = document.querySelector("#loading-caption");
  const gsap = window.gsap;
  if (!screen || !progress) return { finish: () => {} };

  let colorTimeline = null;
  if (gsap && !prefersReducedMotion()) {
    colorTimeline = gsap.timeline({ repeat: -1, defaults: { ease: "sine.inOut" } })
      .to(".loading-flag", {
        duration: 0.42,
        fill: (index) => FLAG_COLORS[(index + 1) % FLAG_COLORS.length],
        stagger: 0.08
      })
      .to(".loading-logo", { duration: 0.55, rotation: 2, yoyo: true, repeat: 1 }, "<")
      .to(progress, { duration: 1.4, scaleX: 1, transformOrigin: "left center" }, 0)
      .to(progress, { duration: 1.1, scaleX: 0.32, transformOrigin: "right center" })
      .set(progress, { scaleX: 0.08 });
  } else {
    progress.style.transform = "scaleX(0.62)";
  }

  return {
    finish() {
      if (caption) caption.textContent = "The market is ready. São João can begin.";
      colorTimeline?.kill();
      if (gsap && !prefersReducedMotion()) {
        gsap.timeline({ onComplete: () => screen.remove() })
          .to(progress, { duration: 0.28, scaleX: 1, ease: "power2.out" })
          .to(screen, { duration: 0.5, autoAlpha: 0, yPercent: -4, ease: "power3.inOut" });
      } else {
        screen.remove();
      }
    }
  };
}

function createTriangleBeat() {
  let context = null;
  let timer = null;
  let step = 0;
  const tempo = 104;
  const pattern = [1, 0.54, 0.72, 0, 0.86, 0.48, 0.68, 0, 1, 0.54, 0.72, 0, 0.86, 0.48, 0.68, 0.42];

  function hit(accent) {
    if (!context) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const overtone = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(2_450 + accent * 180, now);
    overtone.type = "sine";
    overtone.frequency.setValueAtTime(4_900 + accent * 240, now);
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1_500, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + accent * 0.035, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085 + accent * 0.025);
    oscillator.connect(filter);
    overtone.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    overtone.start(now);
    oscillator.stop(now + 0.12);
    overtone.stop(now + 0.12);
  }

  function tick() {
    const accent = pattern[step % pattern.length];
    if (accent) hit(accent);
    step += 1;
  }

  return {
    async toggle() {
      if (timer) {
        window.clearInterval(timer);
        timer = null;
        await context?.suspend();
        return false;
      }
      context ||= new (window.AudioContext || window.webkitAudioContext)();
      await context.resume();
      step = 0;
      tick();
      timer = window.setInterval(tick, (60_000 / tempo) / 4);
      return true;
    },
    stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      context?.close();
      context = null;
    }
  };
}

export function setupSaoJoao() {
  const loading = animateLoadingScreen();
  const beat = createTriangleBeat();
  const buttons = [document.querySelector("#loading-triangle-toggle")].filter(Boolean);

  async function toggleBeat() {
    const enabled = await beat.toggle();
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("is-playing", enabled);
      const label = button.querySelector("small");
      if (label) label.textContent = enabled ? "on" : "off";
      const text = button.querySelector("span:last-child");
      if (text && !label) text.textContent = enabled ? "Pause the triangle beat" : "Start the triangle beat";
    }
  }

  for (const button of buttons) button.addEventListener("click", toggleBeat);
  return {
    finish() {
      beat.stop();
      loading.finish();
    }
  };
}
