(() => {
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (s) => { s = Math.floor(s + 0.01); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const hasKey = !!(C.googleApiKey && C.googleApiKey.trim());
  if (!hasKey) document.body.classList.add("nokey");

  // ---------------------------------------------------------------
  //  Geometria traseului (în metri, proiecție locală)
  // ---------------------------------------------------------------
  const pts = window.TRASEU;
  const lat0 = pts[0][0], lng0 = pts[0][1];
  const KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540;
  const toXY = ([lat, lng]) => [(lng - lng0) * KX, (lat - lat0) * KY];
  const xy = pts.map(toXY);
  const cum = [0];
  for (let i = 1; i < xy.length; i++)
    cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const total = cum[cum.length - 1];

  function segAt(d) {
    d = clamp(d, 0, total);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const len = cum[hi] - cum[lo] || 1;
    return { i: lo, t: (d - cum[lo]) / len };
  }
  function pointAt(d) {
    const { i, t } = segAt(d);
    const a = pts[i], b = pts[i + 1] || a;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function headingAt(d) {
    const a = toXY(pointAt(d - 4)), b = toXY(pointAt(d + 16));
    return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  }
  // cel mai apropiat punct de pe traseu → distanța de la start
  function project(lat, lng) {
    const p = toXY([lat, lng]);
    let best = { dist: Infinity, d: 0 };
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
      const t = clamp(((p[0] - ax) * vx + (p[1] - ay) * vy) / L2, 0, 1);
      const dd = Math.hypot(ax + vx * t - p[0], ay + vy * t - p[1]);
      if (dd < best.dist - 0.5) best = { dist: dd, d: cum[i] + t * Math.sqrt(L2) };
    }
    return best.d;
  }

  // ---------------------------------------------------------------
  //  Momente și melodii
  // ---------------------------------------------------------------
  const moments = (C.momente || []).map((m) => ({
    ...m,
    d: m.metru != null ? m.metru : project(m.lat, m.lng),
    pauza: m.pauza == null ? 0 : m.pauza,
  })).sort((a, b) => a.d - b.d);
  let n = 0;
  moments.forEach((m) => { if (m.pauza !== 0) m.num = ++n; });
  const momentById = Object.fromEntries(moments.map((m) => [m.id, m]));

  const toMeter = (v, dflt) => typeof v === "number" ? v : (momentById[v] ? momentById[v].d : dflt);
  const songs = (C.melodii || []).map((s) => {
    const d = toMeter(s.dela, 0);
    const audio = new Audio(encodeURI(s.fisier));
    audio.loop = s.pana == null; audio.volume = 0; audio.preload = "auto";
    audio.onerror = () => toast(`Nu pot reda „${s.titlu || s.fisier}” — verifică numele fișierului în config.js`);
    return { ...s, d, end: s.panaLa != null ? toMeter(s.panaLa, Infinity) : Infinity,
      de: s.de || 0, audio, vol: 0 };
  }).sort((a, b) => a.d - b.d);
  // porțiunile de traseu care durează exact cât bucata lor de melodie
  const syncSpans = songs.filter((s) => s.sincron && s.pana != null && s.end < Infinity)
    .map((s) => {
      // capetele foarte aproape de start / final se lipesc de ele
      if (s.d < 15) s.d = 0;
      if (s.end > total - 15) s.end = total;
      return { a: s.d, b: s.end, dur: s.pana - s.de, song: s };
    });
  // porțiuni în care, în loc de Street View, se văd pozele mele pe tot ecranul
  const photoSpans = (C.secventeFoto || []).map((p) => ({
    a: toMeter(p.dela, 0), b: toMeter(p.panaLa, total), photos: p.poze || [], durata: p.durata,
  })).filter((p) => p.photos.length && p.b > p.a);

  // ---------------------------------------------------------------
  //  Cadre lungi (din config, sau alese în pagină și ținute în browser)
  // ---------------------------------------------------------------
  const LS_KEY = "harta-cadre-lungi";
  function loadHolds() {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return (C.cadreLungi || []).map((h) => ({ ...h }));
  }
  function saveHolds() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(holds)); } catch (e) {}
  }
  let holds = loadHolds();

  // ---------------------------------------------------------------
  //  Cronologia filmului: cadre normale + cadre lungi + cartonașe,
  //  totul încăput în durataTotala.
  // ---------------------------------------------------------------
  const TOTAL_T = C.durataTotala || 240;
  const MIN_FRAME = C.durataCadru || 5;
  let items = [], T = TOTAL_T, frameDur = MIN_FRAME;

  function frameUrl(d, w = 640, h = 400) {
    const [la, ln] = pointAt(d);
    return `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}` +
      `&location=${la.toFixed(7)},${ln.toFixed(7)}&heading=${headingAt(d).toFixed(1)}` +
      `&fov=${C.fov || 90}&pitch=${C.pitch || 0}&radius=50&source=outdoor&return_error_code=true` +
      `&key=${encodeURIComponent((C.googleApiKey || "").trim())}`;
  }

  // camera stă pe stradă, în dreptul momentului, și privește spre locul lui
  // (sau unde spune „vedere: [lat, lng, direcție]” din config)
  function viewUrl(m) {
    let [la, ln] = pointAt(m.d);
    const a = toXY([la, ln]), b = toXY([m.lat, m.lng]);
    let heading = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
    if (m.vedere) [la, ln, heading] = m.vedere;
    return `https://maps.googleapis.com/maps/api/streetview?size=640x400` +
      `&location=${la.toFixed(7)},${ln.toFixed(7)}&heading=${heading.toFixed(1)}` +
      `&fov=${m.fov || 80}&pitch=${m.pitch || 5}&radius=50&source=outdoor&return_error_code=true` +
      `&key=${encodeURIComponent((C.googleApiKey || "").trim())}`;
  }

  function build() {
    const holdItems = holds.map((h) => ({
      kind: "frame", hold: true, src: h,
      d: clamp(h.metru != null ? h.metru : project(h.lat, h.lng), 0, total),
      dur: h.durata || 30, comentariu: h.comentariu,
    }));
    const stopItems = moments.filter((m) => m.pauza !== 0).map((m) => ({
      kind: "stop", d: m.d, dur: Math.max(0, m.pauza), wait: m.pauza < 0, m,
    }));
    // momente cu „cadru”: un cadru Street View care privește spre locul momentului
    const viewItems = moments.filter((m) => m.cadru > 0).map((m) => ({
      kind: "frame", view: true, d: m.d, dur: m.cadru, m,
    }));
    // traseul împărțit în porțiuni: cele sincronizate cu muzica au durată fixă,
    // restul își împart timpul rămas proporțional cu lungimea
    const cuts = [...new Set([0, total, ...syncSpans.flatMap((s) => [s.a, s.b]),
      ...photoSpans.flatMap((s) => [s.a, s.b])])]
      .filter((d) => d >= 0 && d <= total).sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      // durată fixă: porțiune sincronizată cu muzica sau secvență foto cu „durata”
      const ps = photoSpans.find((p) => p.durata && p.a <= a + 0.01 && p.b >= b - 0.01);
      const locked = syncSpans.find((s) => s.a <= a && s.b >= b) || (ps && { a: ps.a, b: ps.b, dur: ps.durata });
      const inside = (x) => x.d >= a && (x.d < b || (b === total && x.d <= b));
      const fixed = [...holdItems, ...stopItems, ...viewItems].filter(inside).reduce((s, x) => s + x.dur, 0);
      spans.push({ a, b, locked, fixed,
        free: locked ? Math.max(0, locked.dur * (b - a) / (locked.b - locked.a) - fixed) : 0 });
    }
    const flexible = spans.filter((s) => !s.locked);
    const flexLen = flexible.reduce((s, x) => s + x.b - x.a, 0) || 1;
    const flexFree = Math.max(MIN_FRAME, TOTAL_T - spans.reduce((s, x) => s + x.fixed + x.free, 0));
    flexible.forEach((s) => (s.free = flexFree * (s.b - s.a) / flexLen));
    const normal = [];
    let nNormal = 0, freeSum = 0;
    spans.forEach((s) => {
      const ps = photoSpans.find((p) => p.a <= s.a + 0.01 && p.b >= s.b - 0.01);
      if (ps) {
        // pozele porțiunii, împărțite egal pe timpul ei (o porțiune poate fi tăiată
        // în bucăți de alte repere, așa că fiecare bucată își ia pozele ei)
        const from = Math.floor(ps.photos.length * (s.a - ps.a) / (ps.b - ps.a) + 0.001);
        const to = Math.floor(ps.photos.length * (s.b - ps.a) / (ps.b - ps.a) + 0.001);
        const photos = ps.photos.slice(from, Math.max(to, from + 1));
        // o intrare e fie o poză, fie { poza, desen } — desenul apare lângă poză
        photos.forEach((p, i) => normal.push({
          kind: "frame", photo: typeof p === "string" ? p : p.poza, pair: typeof p === "string" ? null : p.desen,
          d: s.a + i * (s.b - s.a) / photos.length, dur: s.free / photos.length,
        }));
        return;
      }
      const N = Math.max(1, Math.floor(s.free / MIN_FRAME + 0.001));
      const dur = s.free / N;
      for (let i = 0; i < N; i++) normal.push({ kind: "frame", d: s.a + i * (s.b - s.a) / N, dur });
      nNormal += N; freeSum += s.free;
    });
    frameDur = freeSum / nNormal;
    const order = (x) => (x.kind === "frame" ? 0 : 1);
    items = [...normal, ...holdItems, ...viewItems, ...stopItems].sort((a, b) => a.d - b.d || order(a) - order(b));
    let t = 0;
    items.forEach((x, i) => { x.t0 = t; x.idx = i; t += x.dur; });
    T = t;
    // momentul din film în care începe fiecare porțiune sincronizată
    syncSpans.forEach((s) => (s.song.t0 = timeAtMeter(s.a)));
    // pentru fiecare cadru: următorul cadru (spre care merge omulețul pe hartă)
    let next = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const x = items[i];
      if (x.kind === "frame") { x.next = next; next = x; if (hasKey) preload(x); }
    }
    renderTicks();
  }

  // timpul din film la care omulețul ajunge la metrul d
  function timeAtMeter(d) {
    const x = items.find((it) => it.d >= d - 0.01);
    return x ? x.t0 : T;
  }

  const cache = new Map();
  function preload(x) {
    x.url = x.photo ? encodeURI(x.photo) : x.view ? viewUrl(x.m) : frameUrl(x.d);
    let e = cache.get(x.url);
    if (!e) {
      // Street View mai răspunde din când în când cu eroare: reîncercăm de câteva ori
      e = { state: "loading", src: x.url, tries: 0 };
      const img = new Image();
      img.onload = () => (e.state = "ok");
      img.onerror = () => {
        if (x.photo || ++e.tries > 4) { e.state = "fail"; return; }
        setTimeout(() => { e.src = `${x.url}&retry=${e.tries}`; img.src = e.src; }, 800 * e.tries);
      };
      img.src = e.src;
      cache.set(x.url, e);
    }
    x.cache = e;
  }

  function itemAt(t) {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (items[m].t0 <= t) lo = m; else hi = m - 1; }
    // la același t0, cartonașele de durată 0 (așteptare) vin după cadru
    return items[lo];
  }
  // cadrul de afișat: cel curent sau ultimul de dinainte (în timpul cartonașelor)
  function frameAt(t) {
    for (let i = itemAt(t).idx; i >= 0; i--) {
      const x = items[i];
      if (x.kind === "frame" && (!hasKey || x.cache.state !== "fail")) return x;
    }
    return null;
  }
  function meterAt(t) {
    const x = itemAt(t);
    if (x.kind !== "frame" || x.hold || x.view) return x.d;
    const to = x.next ? x.next.d : total;
    return x.d + (to - x.d) * clamp((t - x.t0) / x.dur, 0, 1);
  }

  // ---------------------------------------------------------------
  //  Stare
  // ---------------------------------------------------------------
  let time = 0, dist = 0, playing = false, started = false, muted = false;
  let waiting = null;          // cartonaș cu pauza -1 care așteaptă spațiu
  const waitDone = new Set();
  const subDone = new Set();
  let subtitleLeft = 0;

  // ---------------------------------------------------------------
  //  Afișarea cadrelor
  // ---------------------------------------------------------------
  const fA = $("frameA"), fB = $("frameB");
  let front = fA, back = fB, shown = null;
  function updateFrames() {
    if (!hasKey) return;
    const x = frameAt(time);
    if (x && x !== shown && x.cache.state === "ok") {
      back.src = x.cache.src;
      back.style.transform = "scale(1)";
      // pozele mele: întregi pe ecran, cu o variantă blurată a lor pe fundal
      back.classList.toggle("photo", !!x.photo);
      if (x.photo) $("photoBg").src = x.url;
      $("photoBg").classList.toggle("on", !!x.photo);
      // poză + desenul meu, una lângă alta
      back.classList.toggle("pair", !!x.pair);
      if (x.pair) $("pairImg").src = encodeURI(x.pair);
      $("pairImg").classList.toggle("on", !!x.pair);
      back.classList.add("on");
      front.classList.remove("on");
      [front, back] = [back, front];
      shown = x;
    }
    if (shown && C.zoomLent !== false) {
      const p = clamp((time - shown.t0) / Math.max(shown.dur, frameDur), 0, 1);
      front.style.transform = `scale(${1 + p * 0.04})`;
    }
  }

  // fără cheie: imagine satelit care urmărește plimbarea
  let satMap = null;
  if (!hasKey) {
    satMap = L.map("satmap", { zoomControl: false, attributionControl: false, dragging: false,
      scrollWheelZoom: false, doubleClickZoom: false, keyboard: false, boxZoom: false, touchZoom: false })
      .setView(pts[0], 19);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 20, maxNativeZoom: 19 }).addTo(satMap);
    L.polyline(pts, { color: "#f6c69a", weight: 5, opacity: 0.8, dashArray: "2 10", lineCap: "round" }).addTo(satMap);
  }

  // ---------------------------------------------------------------
  //  Hărți
  // ---------------------------------------------------------------
  const map = L.map("minimap", { zoomControl: false, attributionControl: false }).setView(pts[0], 17);
  // Esri merge și când pagina e deschisă direct de pe disc (OpenStreetMap o refuză)
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, maxNativeZoom: 19 }).addTo(map);
  L.polyline(pts, { color: "#2b2420", weight: 4, opacity: 0.35, dashArray: "1 8", lineCap: "round" }).addTo(map);
  const walked = L.polyline([], { color: "#c2410c", weight: 5, opacity: 0.9, lineCap: "round" }).addTo(map);
  const walker = L.marker(pts[0], { icon: L.divIcon({ className: "", html: '<div class="walker"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
  moments.forEach((m) => {
    const walk = m.pauza === 0;
    const icon = L.divIcon({ className: "", html: `<div class="stop-pin${walk ? " walk" : ""}">${walk ? "" : m.num}</div>`,
      iconSize: walk ? [12, 12] : [24, 24] });
    L.marker(pointAt(m.d), { icon }).addTo(map)
      .bindTooltip(m.titlu || "", { className: "stop-tip", direction: "top", offset: [0, -10] })
      .on("click", (ev) => {
        L.DomEvent.stop(ev);
        const it = items.find((x) => x.m === m);
        if (it) seek(it.t0); else seekMeter(m.d);
      });
  });
  map.on("click", (ev) => {
    const d = project(ev.latlng.lat, ev.latlng.lng);
    if (ev.originalEvent.shiftKey) {
      const txt = `lat: ${ev.latlng.lat.toFixed(7)}, lng: ${ev.latlng.lng.toFixed(7)}`;
      navigator.clipboard && navigator.clipboard.writeText(txt).catch(() => {});
      toast(`${txt}  ·  pe traseu la metrul ${Math.round(d)}  (copiat)`);
    } else seekMeter(d);
  });
  let bigMap = false;
  function setBigMap(on) {
    bigMap = on;
    if (document.body.classList.contains("bigmap") === on) return;
    document.body.classList.toggle("bigmap", on);
    clearTimeout(setBigMap.t);
    setBigMap.t = setTimeout(() => {
      map.invalidateSize();
      if (bigMap) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
      else map.setView(pointAt(dist), 17);
    }, 700);
  }
  let mapTimer = 0;
  function updateMap(force) {
    const p = pointAt(dist);
    walker.setLatLng(p);
    if (satMap) satMap.setView(p, 19, { animate: false });
    if (!force && performance.now() - mapTimer < 200) return;
    mapTimer = performance.now();
    const { i } = segAt(dist);
    walked.setLatLngs(pts.slice(0, i + 1).concat([p]));
    if (!bigMap) map.panTo(p, { animate: false });
  }

  // ---------------------------------------------------------------
  //  Cartonaș, subtitlu, suprapunere
  // ---------------------------------------------------------------
  const card = $("card");
  let cardMoment = null;
  function openCard(m) {
    cardMoment = m;
    card.querySelector(".card-num").textContent = m.num ? m.num + "." : "";
    card.querySelector(".card-title").textContent = m.titlu || "";
    card.querySelector(".card-text").textContent = m.comentariu || "";
    const media = card.querySelector(".card-media");
    media.innerHTML = "";
    const add = (src, cls) => {
      const img = document.createElement("img");
      img.src = src; img.className = cls;
      img.onerror = () => img.remove();
      img.onclick = () => { $("lightbox").querySelector("img").src = src; $("lightbox").classList.remove("hidden"); };
      media.appendChild(img);
    };
    (m.poze || []).forEach((s) => add(s, "poza"));
    (m.desene || []).forEach((s) => add(s, "desen"));
    // cu cât sunt mai multe poze, cu atât mai mici, ca să încapă toate deodată
    const k = media.children.length;
    const h = k <= 3 ? 240 : k <= 5 ? 190 : k <= 8 ? 150 : 125;
    media.style.setProperty("--ph", `min(${h}px, ${Math.round(h / 8)}vh)`);
    card.classList.remove("hidden");
  }
  function hideCard() {
    if (!cardMoment) return;
    cardMoment = null;
    card.classList.add("hidden");
  }
  function updateCard() {
    const x = itemAt(time);
    const m = waiting ? waiting.m : (x.kind === "stop" && x.dur > 0 ? x.m : null);
    if (m !== cardMoment) { if (m) openCard(m); else hideCard(); }
    if (m) card.querySelector(".card-timer").textContent = waiting
      ? "apasă spațiu ca să continui"
      : `continuă în ${Math.ceil(x.t0 + x.dur - time)} s`;
    // desenul pus peste stradă: cât stă cartonașul și încă ~25 m după
    const ov = $("overlay");
    const om = moments.find((k) => k.suprapunere && dist >= k.d - 0.5 && dist <= k.d + 25);
    if (om) { if (!ov.src.endsWith(om.suprapunere)) ov.src = om.suprapunere; ov.classList.add("on"); }
    else ov.classList.remove("on");
  }
  function showSubtitle(text, secs) {
    $("subtitle").textContent = text;
    $("subtitle").classList.add("on");
    subtitleLeft = secs || clamp(text.length * 0.075, 4, 12);
  }
  function toast(t) {
    $("toast").textContent = t;
    $("toast").classList.add("on");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $("toast").classList.remove("on"), 4000);
  }

  // ---------------------------------------------------------------
  //  Apariții: poze și texte puse după timpul din film, cu o poziție pe ecran
  // ---------------------------------------------------------------
  const parseTime = (v) => {
    if (typeof v === "number") return v;
    const p = String(v).trim().split(":").map(Number);
    return p.length === 2 ? p[0] * 60 + p[1] : p[0];
  };
  const POS = ["stanga-sus", "sus", "dreapta-sus", "stanga", "centru", "dreapta", "stanga-jos", "jos", "dreapta-jos"];
  const shows = (C.aparitii || []).map((a) => {
    const el = document.createElement("div");
    const pos = POS.includes(a.pozitie) ? a.pozitie : (a.poza ? "dreapta" : "jos");
    el.className = `ap pos-${pos}` + (a.poza ? " ap-photo" : " ap-text");
    if (a.poza) {
      const img = document.createElement("img");
      img.src = encodeURI(a.poza);
      img.onerror = () => { img.remove(); toast(`Nu găsesc poza ${a.poza} — verifică calea în config.js`); };
      img.onclick = () => { $("lightbox").querySelector("img").src = img.src; $("lightbox").classList.remove("hidden"); };
      el.appendChild(img);
    }
    if (a.text) {
      const t = document.createElement("div");
      t.className = "ap-caption";
      t.textContent = a.text;
      el.appendChild(t);
    }
    $("aparitii").appendChild(el);
    const t0 = parseTime(a.timp || 0);
    return { ...a, el, t0, t1: t0 + (a.durata || 5) };
  }).sort((a, b) => a.t0 - b.t0);
  function updateShows() {
    for (const s of shows) s.el.classList.toggle("on", time >= s.t0 && time < s.t1);
  }

  // ---------------------------------------------------------------
  //  Muzică
  // ---------------------------------------------------------------
  let currentSong = null;
  function updateMusic(dt) {
    let s = null;
    for (const x of songs) if (x.d <= dist + 0.01) s = x;
    if (s && dist >= s.end - 0.01) s = null;
    if (s !== currentSong) {
      currentSong = s;
      if (!s) $("nowplaying").classList.remove("on");
      if (s) {
        if (!s.sincron) try { s.audio.currentTime = s.de; } catch (e) {}
        $("nowplaying").innerHTML = `♪ <i></i> — <span></span>`;
        $("nowplaying").querySelector("i").textContent = s.titlu || s.fisier;
        $("nowplaying").querySelector("span").textContent = s.artist || "";
        $("nowplaying").classList.add("on");
        clearTimeout(updateMusic.t);
        updateMusic.t = setTimeout(() => $("nowplaying").classList.remove("on"), 6000);
      }
    }
    const vol = clamp(C.volumMuzica ?? 0.7, 0, 1);
    for (const x of songs) {
      const target = x === currentSong && playing && !muted ? vol : 0;
      const fade = x.sincron ? 0.6 : 2.5; // secunde de crossfade
      x.vol += clamp(target - x.vol, -dt / fade, dt / fade);
      x.audio.volume = clamp(x.vol, 0, 1);
      if (x === currentSong && playing && x.audio.readyState > 0) {
        if (x.sincron) {
          // bucata de melodie ține pasul cu filmul (și după pauze sau sărituri);
          // corectăm rar, ca să nu blocăm redarea cu căutări repetate
          const want = x.de + (time - x.t0);
          const now = performance.now();
          if (!x.audio.seeking && Math.abs(x.audio.currentTime - want) > 0.6 && now - (x.lastSync || 0) > 1500) {
            x.lastSync = now;
            try { x.audio.currentTime = want; } catch (e) {}
          }
        } else if (x.pana != null && x.audio.currentTime >= x.pana) {
          try { x.audio.currentTime = x.de; } catch (e) {}
        }
      }
      if (target > 0 && x.audio.paused && started) x.audio.play().catch(() => {});
      if (x.vol <= 0.001 && !x.audio.paused) x.audio.pause();
    }
  }

  // ---------------------------------------------------------------
  //  Control
  // ---------------------------------------------------------------
  function seek(t) {
    time = clamp(t, 0, T);
    waiting = null;
    waitDone.clear(); subDone.clear();
    items.forEach((x) => { if (x.wait && x.t0 < time) waitDone.add(x); });
    dist = meterAt(time);
    moments.forEach((m) => { if (m.pauza === 0 && m.d < dist) subDone.add(m); });
    items.forEach((x) => { if (x.hold && x.t0 < time - 0.01) subDone.add(x.src); });
    $("subtitle").classList.remove("on");
    updateMap(true);
  }
  function seekMeter(d) {
    const x = items.find((it) => it.kind === "frame" && it.next && it.next.d > d) || items[items.length - 1];
    seek(x.t0);
  }
  // sare între cartonașe și cadrele lungi
  function stepMoment(dir) {
    // reperele: cartonașe, cadre lungi și începutul fiecărui grup de poze
    const marks = [...new Set([
      ...items.filter((x) => x.kind === "stop" || x.hold).map((x) => x.t0),
      ...shows.map((s) => s.t0),
      ...syncSpans.map((s) => s.song.t0),
    ])].sort((a, b) => a - b);
    const t = dir > 0 ? marks.find((k) => k > time + 0.5) : [...marks].reverse().find((k) => k < time - 1.5);
    if (t != null) seek(t); else if (dir < 0) seek(0);
  }
  function continueWait() {
    if (!waiting) return false;
    waitDone.add(waiting);
    waiting = null;
    return true;
  }
  function togglePlay() {
    if (!playing && time >= T - 0.05) seek(0);
    playing = !playing;
    if (playing) setBigMap(false);
    updatePlayBtn();
  }
  function updatePlayBtn() { $("playBtn").textContent = playing ? "❚❚" : "▶"; }

  $("playBtn").onclick = togglePlay;
  $("cardNext").onclick = () => {
    if (!continueWait()) {
      const x = itemAt(time);
      if (x.kind === "stop") seek(x.t0 + x.dur);
    }
    if (!playing) { playing = true; updatePlayBtn(); }
  };
  $("muteBtn").onclick = () => { muted = !muted; $("muteBtn").classList.toggle("off", muted); };
  $("fsBtn").onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  $("mapToggle").onclick = () => setBigMap(!bigMap);
  $("lightbox").onclick = () => $("lightbox").classList.add("hidden");

  const scrub = $("scrub");
  const scrubTo = (ev) => { const r = scrub.getBoundingClientRect(); seek(clamp((ev.clientX - r.left) / r.width, 0, 1) * T); };
  scrub.addEventListener("pointerdown", (ev) => {
    scrub.setPointerCapture(ev.pointerId); scrubTo(ev);
    const mv = (e) => scrubTo(e);
    scrub.addEventListener("pointermove", mv);
    scrub.addEventListener("pointerup", () => scrub.removeEventListener("pointermove", mv), { once: true });
  });
  function renderTicks() {
    const box = $("scrubTicks");
    box.innerHTML = "";
    const tick = (t, cls, title) => {
      const s = document.createElement("span");
      s.style.left = (t / T * 100) + "%";
      if (cls) s.className = cls;
      s.title = title || "";
      box.appendChild(s);
    };
    items.forEach((x) => {
      if (x.kind === "stop") tick(x.t0, "", x.m.titlu);
      else if (x.hold) tick(x.t0, "hold", `cadru lung · ${x.dur} s`);
    });
    shows.forEach((s) => tick(s.t0, "walk", `${fmt(s.t0)} · ${s.text || s.poza || ""}`));
  }

  // ---------------------------------------------------------------
  //  Alegerea cadrelor lungi
  // ---------------------------------------------------------------
  const gallery = $("gallery");
  let galleryOpen = false;
  function renderGallery() {
    const nHolds = holds.length;
    $("galInfo").textContent =
      `Total ${fmt(T)} · ${items.filter((x) => x.kind === "frame" && !x.hold).length} cadre × ${frameDur.toFixed(1)} s` +
      (nHolds ? ` · ${nHolds} ${nHolds === 1 ? "cadru lung" : "cadre lungi"}` : "");
    const grid = $("galGrid");
    grid.innerHTML = "";
    items.forEach((x) => {
      const el = document.createElement("div");
      if (x.kind === "stop") {
        el.className = "gal-item stop";
        el.textContent = `${x.m.num}. ${x.m.titlu || ""} — cartonaș ${x.wait ? "(așteaptă)" : x.dur + " s"}`;
        grid.appendChild(el);
        return;
      }
      el.className = "gal-item" + (x.hold ? " hold" : "");
      if (x.hold) el.dataset.hold = `${x.dur} s`;
      const img = document.createElement("img");
      img.loading = "lazy";
      if (hasKey) img.src = x.cache ? x.cache.src : x.url;
      img.onerror = () => { img.removeAttribute("src"); img.alt = "fără Street View aici"; };
      const lbl = document.createElement("div");
      lbl.className = "lbl";
      lbl.textContent = `${fmt(x.t0)} · metrul ${Math.round(x.d)}`;
      el.append(img, lbl);
      if (!x.photo && !x.view) el.onclick = () => {
        if (x.hold) holds = holds.filter((h) => h !== x.src);
        else holds.push({ metru: Math.round(x.d), durata: 30 });
        saveHolds();
        build();
        seek(0);
        renderGallery();
      };
      grid.appendChild(el);
    });
  }
  function setGallery(on) {
    galleryOpen = on;
    gallery.classList.toggle("hidden", !on);
    if (on) { playing = false; updatePlayBtn(); renderGallery(); }
  }
  $("galleryBtn").onclick = () => setGallery(true);
  $("galClose").onclick = () => setGallery(false);
  $("galReset").onclick = () => {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    holds = (C.cadreLungi || []).map((h) => ({ ...h }));
    build(); seek(0); renderGallery();
  };
  $("galCopy").onclick = () => {
    const txt = "cadreLungi: [\n" + holds.map((h) =>
      `    { metru: ${h.metru}, durata: ${h.durata || 30}${h.comentariu ? `, comentariu: ${JSON.stringify(h.comentariu)}` : ""} }`
    ).join(",\n") + "\n  ],";
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => toast("Copiat — lipește în config.js în locul liniei cadreLungi"))
      .catch(() => { console.log(txt); toast("Nu am putut copia; textul e în consola browserului"); });
  };

  document.addEventListener("keydown", (e) => {
    if (!started) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } return; }
    if (galleryOpen) { if (e.key === "Escape" || e.key === "g" || e.key === "G") setGallery(false); return; }
    if (e.key === " ") { e.preventDefault(); if (cardMoment) $("cardNext").click(); else togglePlay(); }
    else if (e.key === "ArrowRight") stepMoment(1);
    else if (e.key === "ArrowLeft") stepMoment(-1);
    else if (e.key === "g" || e.key === "G") setGallery(true);
    else if (e.key === "c" || e.key === "C") {
      // copiază timpul curent, ca să-l pui la „timp” în config.js
      const s = `${Math.floor(time / 60)}:${(time % 60).toFixed(1).padStart(4, "0")}`;
      navigator.clipboard && navigator.clipboard.writeText(`"${s}"`).catch(() => {});
      toast(`timp: "${s}" (copiat)`);
    }
    else if (e.key === "m" || e.key === "M") setBigMap(!bigMap);
    else if (e.key === "s" || e.key === "S") $("muteBtn").click();
    else if (e.key === "f" || e.key === "F") $("fsBtn").click();
    else if (e.key === "Escape") { $("lightbox").classList.add("hidden"); if (bigMap) setBigMap(false); }
  });

  let idleT;
  document.addEventListener("pointermove", () => {
    document.body.classList.remove("idle");
    clearTimeout(idleT);
    idleT = setTimeout(() => playing && document.body.classList.add("idle"), 3000);
  });

  // ---------------------------------------------------------------
  //  Intro + buclă
  // ---------------------------------------------------------------
  build();
  $("introTitle").textContent = C.titlu || "";
  $("introSub").textContent = C.subtitlu || "";
  document.title = C.titlu || document.title;
  $("introNote").textContent = hasKey
    ? `${Math.round(total)} m · ${fmt(T)}`
    : `${Math.round(total)} m · ${fmt(T)} · nu ai pus cheia Google în config.js, așa că vederea e din satelit în loc de Street View`;
  function start() {
    if (started) return;
    started = true;
    $("intro").classList.add("gone");
    // Safari lasă sunetul să pornească doar dacă play() e chemat direct din click:
    // „deblocăm” fiecare melodie acum, în liniște, ca să poată porni mai târziu
    songs.forEach((s) => {
      s.audio.muted = true;
      const p = s.audio.play();
      const done = () => { if (s !== currentSong) s.audio.pause(); s.audio.muted = false; };
      p && p.then ? p.then(done, done) : done();
    });
    playing = true; updatePlayBtn();
  }
  $("startBtn").onclick = start;
  window.__harta = { songs, moments, timeAtMeter, get items() { return items; }, get time() { return time; } }; // pentru depanare în consolă
  seek(0);

  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && !waiting) {
      const nt = Math.min(T, time + dt);
      const w = items.find((x) => x.wait && !waitDone.has(x) && x.t0 >= time && x.t0 <= nt);
      if (w) { time = w.t0; waiting = w; }
      else time = nt;
      const prev = dist;
      dist = meterAt(time);
      // comentarii în mers (subtitluri)
      moments.forEach((m) => {
        if (m.pauza === 0 && m.comentariu && !subDone.has(m) && m.d >= prev - 0.01 && m.d <= dist + 0.01) {
          subDone.add(m); showSubtitle(m.comentariu);
        }
      });
      // comentariul unui cadru lung stă cât stă cadrul
      const x = itemAt(time);
      if (x.hold && x.comentariu && !subDone.has(x.src)) {
        subDone.add(x.src); showSubtitle(x.comentariu, x.dur - 0.5);
      }
      if (time >= T && !waiting) { playing = false; updatePlayBtn(); setBigMap(true); }
    }
    if (subtitleLeft > 0 && playing) {
      subtitleLeft -= dt;
      if (subtitleLeft <= 0) $("subtitle").classList.remove("on");
    }

    updateCard();
    updateShows();
    updateFrames();
    updateMap(false);
    updateMusic(dt);
    $("scrubFill").style.width = (time / T * 100) + "%";
    $("distLabel").textContent = `${fmt(time)} / ${fmt(T)}`;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
