const M = 5.0;
console.log(`⚡️ Applying Speedster ${M}×`);

// —— JS timers ——
const oTimeout = window.setTimeout.bind(window);
window.setTimeout = (fn, d = 0, ...args) => oTimeout(fn, d / M, ...args);
const oInterval = window.setInterval.bind(window);
window.setInterval = (fn, d = 0, ...args) => oInterval(fn, d / M, ...args);

// —— Clocks ——
const oDateNow = Date.now.bind(Date);
const baseDate = oDateNow();
Date.now = () => baseDate + (oDateNow() - baseDate) * M;
const oPerfNow = performance.now.bind(performance);
const basePerf = oPerfNow();
performance.now = () => (oPerfNow() - basePerf) * M;

// —— Optimized requestAnimationFrame ——
// Only call original once per frame, but scale the timestamp
const oRAF = window.requestAnimationFrame.bind(window);
let lastRAF = null;
window.requestAnimationFrame = (cb) => {
	return oRAF((ts) => {
		const scaledTs = ts * M;
		cb(scaledTs);
		lastRAF = ts;
	});
};

// —— CSS & Web Animations ——
const applyCSS = () => {
	document.getAnimations().forEach((anim) => {
		try {
			anim.playbackRate = M;
		} catch {}
	});
};
applyCSS();
setInterval(applyCSS, 200);

// —— Media Elements ——
const forceRate = (el) => {
	el.playbackRate = M;
};
document.querySelectorAll("video,audio").forEach(forceRate);
new MutationObserver((ms) => {
	ms.forEach((m) =>
		m.addedNodes.forEach((n) => {
			if (n.nodeType === 1 && /VIDEO|AUDIO/.test(n.tagName)) forceRate(n);
		})
	);
}).observe(document.documentElement, { childList: true, subtree: true });

// —— GSAP ——
if (window.gsap && gsap.globalTimeline) {
	gsap.globalTimeline.timeScale(M);
	const oTL = gsap.timeline;
	gsap.timeline = (opts) => oTL.call(gsap, { ...(opts || {}), timeScale: M });
}

// —— p5.js ——
if (window.p5 && p5.prototype._draw) {
	const oMillis = p5.prototype.millis;
	p5.prototype.millis = function () {
		return oMillis.call(this) * M;
	};
	const oDraw = p5.prototype._draw;
	p5.prototype._draw = function () {
		this.deltaTime *= M;
		return oDraw.apply(this, arguments);
	};
}

console.log("🚀 Speedster fully applied");
