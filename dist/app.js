"use strict";

// #region State

// DOM helpers, palette, and initial editor state.
const $ = (id) => document.getElementById(id),
  palette = ["#8b8ee8", "#e8a0b0", "#83c7b6", "#e8c477", "#8bb8e2", "#b9a0da"];
let menuOpen = false,
  regionFills = {},
  bucketMode = false,
  unfillMode = false,
  bucketColor = "#000000";
let circles = [
    {
      id: 1,
      x: 410,
      y: 290,
      r: 180,
      color: palette[0],
      opacity: 55,
      texture: "solid",
      label: "A",
    },
    {
      id: 2,
      x: 590,
      y: 290,
      r: 180,
      color: palette[1],
      opacity: 55,
      texture: "solid",
      label: "B",
    },
    {
      id: 3,
      x: 500,
      y: 440,
      r: 180,
      color: palette[2],
      opacity: 55,
      texture: "solid",
      label: "C",
    },
  ],
  active = 1,
  nextId = 4,
  history = [],
  future = [],
  drag = null,
  wheelTimer = null,
  wheelDelta = 0;

// Restore a saved diagram after validating its circles and region fills.
try {
  const saved = JSON.parse(localStorage.getItem("easy-venn-v1"));
  if (
    saved &&
    Array.isArray(saved.circles) &&
    saved.circles.length <= 100 &&
    saved.circles.every(
      (c) =>
        Number.isFinite(c.x) &&
        Number.isFinite(c.y) &&
        Number.isFinite(c.r) &&
        c.r >= 20 &&
        c.r <= 340 &&
        /^#[0-9a-f]{6}$/i.test(c.color) &&
        typeof c.label === "string" &&
        Number.isFinite(c.opacity) &&
        ["solid", "dots", "lines", "cross"].includes(c.texture),
    )
  ) {
    circles = saved.circles.map((c) => ({
      ...c,
      label: /^Circle [A-Z]$/.test(c.label) ? c.label.slice(7) : c.label,
    }));
    nextId = Math.max(0, ...circles.map((c) => c.id)) + 1;
    active = circles[0]?.id ?? null;
    if (saved.regionFills && typeof saved.regionFills === "object") {
      const ids = new Set(circles.map((c) => c.id));
      for (const [key, color] of Object.entries(saved.regionFills)) {
        if (
          /^\d+(,\d+)*$/.test(key) &&
          key.split(",").every((id) => ids.has(Number(id))) &&
          /^#[0-9a-f]{6}$/i.test(color)
        )
          regionFills[key] = color;
      }
    }
  }
} catch {}

// #endregion

// #region Helpers

// Shared escaping, selection, snapping, and bounds helpers.
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const selected = () => circles.find((c) => c.id === active),
  step = () => Number($("snap").value),
  clamp = (n, a, b) => Math.min(b, Math.max(a, n));

// Undo / redo snapshots and local storage persistence.
function snapshot() {
  return JSON.stringify({ circles, active, nextId, regionFills });
}

function remember() {
  history.push(snapshot());
  if (history.length > 80)
    history.shift();
  future = [];
}

function restore(s) {
  ({ circles, active, nextId, regionFills = {} } = JSON.parse(s));
  render();
}

function save() {
  try {
    localStorage.setItem(
      "easy-venn-v1",
      JSON.stringify({ circles, regionFills }),
    );
  } catch {}
}

// #endregion

// #region Area fills

// SVG texture patterns.
function pattern(c) {
  const base = `<pattern id="p${
    c.id
  }" patternUnits="userSpaceOnUse" width="12" height="12"><rect width="12" height="12" fill="${
    c.color
  }" fill-opacity=".22"/>`;
  return (
    base +
    (c.texture === "dots"
      ? `<circle cx="3" cy="3" r="1.6" fill="${c.color}"/>`
      : `<path d="M-3 3L3-3M0 12L12 0M9 15L15 9${
        c.texture === "cross" ? "M0 0L12 12M-3 9L3 15M9-3L15 3" : ""
      }" stroke="${
        c.color
      }" stroke-width="1.5"/>`) +
    "</pattern>"
  );
}

// Region fill tools and SVG clipping geometry.
// A region is identified by exactly the circles containing it, never by pixels.

function regionKeyAt(x, y) {
  return circles
    .filter((c) => (x - c.x) ** 2 + (y - c.y) ** 2 < c.r ** 2)
    .map((c) => c.id)
    .sort((a, b) => a - b)
    .join(",");
}

function fillAreaAt(x, y) {
  const key = regionKeyAt(x, y);
  if (!key)
    return false;
  if (regionFills[key] === bucketColor)
    return false;
  remember();
  regionFills[key] = bucketColor;
  render();
  return true;
}

function unfillAreaAt(x, y) {
  const key = regionKeyAt(x, y);
  if (!key || !Object.hasOwn(regionFills, key))
    return false;
  remember();
  delete regionFills[key];
  render();
  return true;
}

function toggleAreaTool(tool) {
  const wasActive = tool === "fill" ? bucketMode : unfillMode;
  bucketMode = tool === "fill" && !wasActive;
  unfillMode = tool === "unfill" && !wasActive;
  endDrag();
  render();
}

function regionGeometry() {
  const entries = Object.entries(regionFills).filter(([key]) =>
    key.split(",").every((id) => circles.some((c) => c.id === Number(id))),
  );
  if (!entries.length)
    return { defs: "", shapes: "" };
  let defs = circles
      .map(
        (c) =>
          `<clipPath id="regionClip${
            c.id
          }" clipPathUnits="userSpaceOnUse"><circle cx="${
            c.x
          }" cy="${
            c.y
          }" r="${
            c.r
          }"/></clipPath>`,
      )
      .join(""),
    shapes = "";
  entries.forEach(([key, color], i) => {
    const ids = key.split(",").map(Number);
    let inside = '<rect width="1000" height="700" fill="white"/>';
    for (const id of ids)
      inside = `<g clip-path="url(#regionClip${id})">${inside}</g>`;
    const excluded = circles
      .filter((c) => !ids.includes(c.id))
      .map((c) => `<circle cx="${c.x}" cy="${c.y}" r="${c.r}" fill="black"/>`)
      .join("");
    defs += `<mask id="regionMask${
      i
    }" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="1000" height="700" style="mask-type:luminance"><rect width="1000" height="700" fill="black"/>${
      inside
    }${
      excluded
    }</mask>`;
    shapes += `<rect class="region-fill" data-region="${
      key
    }" pointer-events="none" width="1000" height="700" fill="${
      color
    }" mask="url(#regionMask${
      i
    })"/>`;
  });
  return { defs, shapes };
}

// #endregion

// #region Artwork

// Measure and render circle labels, caching text widths.
let labelMeasureContext;
const labelWidths = new Map();

function labelLayout(c) {
  const fontSize = Math.min(22, Math.max(12, c.r / 4)),
    padding = fontSize >= 18 ? 9 : 5,
    limit = c.r * 1.6,
    key = fontSize + ":" + c.label;
  let measured = labelWidths.get(key);
  if (measured === undefined) {
    if (!labelMeasureContext && document.createElement)
      labelMeasureContext = document.createElement("canvas").getContext("2d");
    if (labelMeasureContext) {
      labelMeasureContext.font = "500 " + fontSize + "px Arial";
      measured = labelMeasureContext.measureText(c.label).width;
    } else
      measured =
        Array.from(c.label).reduce(
          (sum, ch) =>
            sum +
            (/[MW@%#]/.test(ch)
              ? 1
              : /[ilI.,' ]/.test(ch)
                ? 0.32
                : ch.charCodeAt(0) > 255
                  ? 1
                  : 0.68),
          0,
        ) * fontSize;
    if (labelWidths.size > 500)
      labelWidths.clear();
    labelWidths.set(key, measured);
  }

  // Fit the label within the circle while preserving padding.
  const textWidth = Math.min(measured, Math.max(10, limit - padding * 2));
  return {
    fontSize,
    textWidth,
    compressed: measured > textWidth,
    width: Math.max(fontSize + padding, textWidth + padding * 2),
    height: fontSize + 10,
  };
}

function labelArtwork(c) {
  if (!c.label.trim())
    return "";
  const l = labelLayout(c);
  return `<g class="circle-label" pointer-events="none" aria-hidden="true"><rect x="${
    c.x - l.width / 2
  }" y="${
    c.y - l.height / 2
  }" width="${
    l.width
  }" height="${
    l.height
  }" rx="${
    Math.min(8, l.height / 4)
  }" fill="#ffffff" stroke="#e4e6ed" stroke-width=".8"/><text x="${
    c.x
  }" y="${
    c.y
  }" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${
    l.fontSize
  }" font-weight="500" fill="#303545"${
    l.compressed ? ` textLength="${l.textWidth}" lengthAdjust="spacingAndGlyphs"` : ""
  }>${
    esc(c.label)
  }</text></g>`;
}

// Compose the diagram SVG, including fills, labels, and selection.
function artwork(selection = true) {
  const regions = regionGeometry();
  return (
    "<defs>" +
    circles
      .filter((c) => c.texture !== "solid")
      .map(pattern)
      .join("") +
    regions.defs +
    "</defs>" +
    circles
      .map(
        (c) =>
          `<circle class="venn-circle" data-id="${
            c.id
          }" cx="${
            c.x
          }" cy="${
            c.y
          }" r="${
            c.r
          }" fill="${
            c.texture === "solid" ? c.color : `url(#p${c.id})`
          }" fill-opacity="${
            c.opacity / 100
          }" stroke="${
            c.color
          }" stroke-opacity=".75" stroke-width="1.3"/>`,
      )
      .join("") +
    regions.shapes +
    circles.map(labelArtwork).join("") +
    (selection && selected() && !bucketMode && !unfillMode
      ? `<circle pointer-events="none" cx="${
        selected().x
      }" cy="${
        selected().y
      }" r="${
        selected().r + 6
      }" fill="none" stroke="#7677a6" stroke-width="1" stroke-dasharray="3 5"/>`
      : "")
  );
}

// #endregion

// #region Rendering

// Refresh the canvas, circle list, toolbar, and appearance controls.
function render(sync = true) {

  // Reflect the active fill tool in the toolbar.
  $("board").classList.toggle("bucket-mode", bucketMode || unfillMode);
  $("unfillTool").setAttribute("aria-pressed", String(unfillMode));
  $("unfillLabel").textContent = unfillMode ? "Done Unfilling" : "Unfill Area";
  $("bucketTool").setAttribute("aria-pressed", String(bucketMode));
  $("bucketLabel").textContent = bucketMode ? "Done Filling" : "Fill Area";
  $("bucketColorControl").hidden = !bucketMode;
  $("canvasHint").textContent = unfillMode
    ? "Click a filled area to restore its circle colors"
    : bucketMode
      ? "Click a circle area to fill · Background stays unchanged"
      : "Click to select · Drag to move · Scroll to resize";

  // Switch between the main menu and the editor.
  const inMenu = menuOpen || !circles.length;
  document.body.classList.toggle("menu-open", inMenu);
  $("empty").hidden = !inMenu;
  $("continueDiagram").hidden = !circles.length;
  $("mainMenu").hidden = inMenu;
  $("exportOpen").hidden = inMenu;

  // Rebuild the diagram and sidebar circle list.
  $("board").innerHTML = artwork();
  $("circleList").innerHTML = circles
    .map(
      (c) =>
        `<div class="circle-row ${
          c.id === active ? "active" : ""
        }" data-row="${
          c.id
        }"><button class="circle-item ${
          c.id === active ? "active" : ""
        }" data-id="${
          c.id
        }" aria-pressed="${
          c.id === active
        }"><span class="dot" style="background:${
          c.color
        }"></span><span class="name">${
          esc(c.label || "Untitled")
        }</span></button><button class="rename-button" data-rename="${
          c.id
        }" aria-label="Rename ${
          esc(c.label || "circle")
        }" title="Rename"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button></div>`,
    )
    .join("");

  // Update selection details and undo / redo availability.
  $("count").textContent = circles.length;
  $("inspector").hidden = !selected();
  $("inspector").style.display = selected() ? "" : "none";
  $("noSelection").hidden = !!selected();
  $("undo").disabled = !history.length;
  $("redo").disabled = !future.length;
  $("selectionStatus").textContent = selected()
    ? (selected().label || "Untitled") + " selected"
    : "One circle at a time";
  if (sync)
    syncInspector();
  save();
}

function syncInspector() {
  const c = selected();
  if (!c)
    return;
  $("color").value = c.color;
  $("hex").textContent = c.color.toUpperCase();
  $("opacity").value = c.opacity;
  $("opacityValue").value = c.opacity + "%";
  $("texture").value = c.texture;
  $("diameter").value = c.r * 2 + " px";
  $("swatches").innerHTML = palette
    .map(
      (color) =>
        `<button class="swatch ${
          color === c.color ? "chosen" : ""
        }" style="background:${
          color
        }" data-color="${
          color
        }" aria-label="Fill ${
          color
        }" aria-pressed="${
          color === c.color
        }"></button>`,
    )
    .join("");
}

// #endregion

// #region Circles

// Circle names and inline renaming.
function letterName(n) {
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function nextLabel() {
  let n = 0;
  while (circles.some((c) => c.label === letterName(n))) n++;
  return letterName(n);
}

function renameCircle(id, label) {
  const c = circles.find((c) => c.id === id);
  if (c && c.label !== label) {
    remember();
    c.label = label;
  }
  active = id;
  render();
}

function editName(id) {
  active = id;
  render();
  const row = $("circleList").querySelector('[data-row="' + id + '"]'),
    c = selected(),
    input = document.createElement("input");
  input.className = "inline-name";
  input.maxLength = 60;
  input.value = c.label;
  input.setAttribute("aria-label", "Rename circle");
  const item = row.querySelector(".circle-item");
  item.replaceWith(input);
  let done = false;
  function finish(cancel = false) {
    if (done)
      return;
    done = true;
    if (cancel)
      render();
    else renameCircle(id, input.value.trim());
  }
  input.addEventListener("blur", () => finish());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(e.key === "Escape");
    }
  });
  input.focus();
  input.select();
}

// Circle creation, starter diagrams, positioning, removal, and resizing.
function add() {
  if (menuOpen)
    return startClassic(1);
  if (circles.length >= 100)
    return toast("Maximum 100 circles");
  remember();
  const id = nextId++;
  circles.push({
    id,
    x: 500,
    y: 350,
    r: 150,
    color: palette[(id - 1) % palette.length],
    opacity: 55,
    texture: "solid",
    label: nextLabel(),
  });
  active = id;
  render();
}

function startClassic(count) {
  remember();
  menuOpen = false;
  bucketMode = false;
  unfillMode = false;
  regionFills = {};
  const positions =
    count === 1
      ? [[500, 350]]
      : count === 2
        ? [
            [410, 350],
            [590, 350],
          ]
        : [
            [410, 275],
            [590, 275],
            [500, 425],
          ];
  circles = positions.map(([x, y], i) => ({
    id: nextId++,
    x,
    y,
    r: count === 1 ? 150 : 180,
    color: palette[i],
    opacity: 55,
    texture: "solid",
    label: letterName(i),
  }));
  active = circles[0].id;
  render();
}

function centerCircle() {
  const c = selected();
  if (!c || (c.x === 500 && c.y === 350))
    return;
  remember();
  c.x = 500;
  c.y = 350;
  render();
}

function remove() {
  if (!selected())
    return;
  remember();
  regionFills = Object.fromEntries(
    Object.entries(regionFills).filter(
      ([key]) => !key.split(",").includes(String(active)),
    ),
  );
  circles = circles.filter((c) => c.id !== active);
  active = circles.at(-1)?.id ?? null;
  render();
}

function resize(direction, record = true) {
  const c = selected();
  if (!c)
    return;
  if (record)
    remember();
  const max = Math.min(c.x, 1000 - c.x, c.y, 700 - c.y, 340),
    d = step();
  c.r = clamp(((Math.round((c.r * 2) / d) + direction) * d) / 2, 20, max);
  render();
}

// #endregion

// #region Controls

// Toolbar, navigation, and circle-list event handlers.
$("bucketTool").onclick = () => toggleAreaTool("fill");
$("unfillTool").onclick = () => toggleAreaTool("unfill");
$("bucketColor").oninput = () => {
  bucketColor = $("bucketColor").value;
};

$("mainMenu").onclick = () => {
  menuOpen = true;
  render();
  $("empty").focus();
};

$("continueDiagram").onclick = () => {
  menuOpen = false;
  render();
  $("board").focus();
};

document.querySelector(".brand").onclick = (e) => {
  e.preventDefault();
  menuOpen = true;
  render();
  $("empty").focus();
};

$("classicTwo").onclick = () => startClassic(2);
$("classicThree").onclick = () => startClassic(3);
$("centerCircle").onclick = centerCircle;
$("add").onclick = add;
$("emptyAdd").onclick = () => startClassic(1);
$("remove").onclick = remove;
$("smaller").onclick = () => resize(-1);
$("larger").onclick = () => resize(1);
$("circleList").onclick = (e) => {
  if (e.target.closest(".inline-name"))
    return;
  const rename = e.target.closest("[data-rename]");
  if (rename) {
    editName(Number(rename.dataset.rename));
    return;
  }
  const b = e.target.closest("[data-id]");
  if (b) {
    active = Number(b.dataset.id);
    render();
  }
};

// Appearance controls: color, opacity, texture, and swatches.
for (const id of ["color", "opacity"]) {
  $(id).addEventListener("focus", () => {
    if (selected())
      remember();
  });
  $(id).addEventListener("input", () => {
    const c = selected();
    if (!c)
      return;
    c[id] = id === "opacity" ? Number($(id).value) : $(id).value;
    render(false);
    $("hex").textContent = c.color.toUpperCase();
    $("opacityValue").value = c.opacity + "%";
  });
}

$("texture").onchange = () => {
  if (selected()) {
    remember();
    selected().texture = $("texture").value;
    render();
  }
};

$("swatches").onclick = (e) => {
  const b = e.target.closest("[data-color]");
  if (b && selected()) {
    remember();
    selected().color = b.dataset.color;
    render();
  }
};

// #endregion

// #region Pointer

// Convert pointer coordinates and handle canvas selection and dragging.
function point(e) {
  const p = new DOMPoint(e.clientX, e.clientY);
  return p.matrixTransform($("board").getScreenCTM().inverse());
}

$("board").onpointerdown = (e) => {
  if (e.button !== 0)
    return;
  e.preventDefault();
  if (bucketMode || unfillMode) {
    const p = point(e);
    if (!regionKeyAt(p.x, p.y))
      toast("Choose an area inside a circle.");
    else if (unfillMode)
      unfillAreaAt(p.x, p.y);
    else fillAreaAt(p.x, p.y);
    return;
  }

  // A click outside a circle clears the selection.
  const id = e.target.dataset.id;
  if (!id) {
    active = null;
    render();
    return;
  }
  active = Number(id);
  remember();
  const p = point(e),
    c = selected();

  // Remember the original pointer and circle positions for dragging.
  drag = { id: c.id, px: p.x, py: p.y, x: c.x, y: c.y };
  $("board").setPointerCapture(e.pointerId);
  $("board").classList.add("dragging");
  $("board").focus();
  render();
};

$("board").onpointermove = (e) => {
  if (!drag)
    return;
  const c = selected(),
    p = point(e),
    s = step();
  c.x = clamp(Math.round((drag.x + p.x - drag.px) / s) * s, c.r, 1000 - c.r);
  c.y = clamp(Math.round((drag.y + p.y - drag.py) / s) * s, c.r, 700 - c.r);
  render(false);
};

function endDrag() {
  drag = null;
  $("board").classList.remove("dragging");
  syncInspector();
}

$("board").onpointerup = endDrag;
$("board").onpointercancel = endDrag;

// Accumulate wheel movement and group resize changes into one undo step.
$("board").addEventListener(
  "wheel",
  (e) => {
    if (!selected())
      return;
    e.preventDefault();
    if (!wheelTimer)
      remember();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      wheelDelta = 0;
    }, 180);
    wheelDelta +=
      e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 700 : 1);
    if (Math.abs(wheelDelta) >= 35) {
      resize(wheelDelta > 0 ? -1 : 1, false);
      wheelDelta = 0;
    }
  },
  { passive: false },
);

// #endregion

// #region Keyboard

// Undo and redo actions.
$("undo").onclick = () => {
  if (history.length) {
    future.push(snapshot());
    restore(history.pop());
  }
};

$("redo").onclick = () => {
  if (future.length) {
    history.push(snapshot());
    restore(future.pop());
  }
};

// Keyboard shortcuts.
document.addEventListener("keydown", (e) => {
  if (
    e.target.matches("input,select,textarea") ||
    document.querySelector("dialog[open]")
  )
    return;
  const key = e.key.toLowerCase();
  if (menuOpen) {
    if (key === "n") {
      e.preventDefault();
      startClassic(1);
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === "z") {
    e.preventDefault();
    $(e.shiftKey ? "redo" : "undo").click();
    return;
  }
  if (key === "n") {
    e.preventDefault();
    add();
  }
  if (key === "b")
    toggleAreaTool("fill");
  if (key === "e")
    toggleAreaTool("unfill");
  if (key === "escape") {
    if (bucketMode || unfillMode) {
      bucketMode = false;
      unfillMode = false;
    } else active = null;
    render();
  }
  if (key === "delete" || key === "backspace") {
    e.preventDefault();
    remove();
  }
  if (key === "+" || key === "=")
    resize(1);
  if (key === "-")
    resize(-1);
  if (selected() && key.startsWith("arrow")) {
    e.preventDefault();
    remember();
    const c = selected(),
      s = step();
    if (key === "arrowleft")
      c.x = clamp(c.x - s, c.r, 1000 - c.r);
    if (key === "arrowright")
      c.x = clamp(c.x + s, c.r, 1000 - c.r);
    if (key === "arrowup")
      c.y = clamp(c.y - s, c.r, 700 - c.r);
    if (key === "arrowdown")
      c.y = clamp(c.y + s, c.r, 700 - c.r);
    render();
  }
});

// #endregion

// #region Export

// Dialog dismissal and opening actions.
for (const d of document.querySelectorAll("dialog")) {
  d.querySelector(".close").onclick = () => d.close();
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  });
}

$("exportOpen").onclick = () => {
  $("exportDialog").showModal();
  exportHint();
};

$("helpOpen").onclick = () => $("helpDialog").showModal();

// Export format, download label, and diagram bounds.
function exportSettings() {
  const transparent = $("format").value === "transparent-png";
  return {
    format: transparent ? "png" : "jpg",
    transparent,
    label: transparent ? "PNG" : "JPG",
  };
}

function exportHint() {
  $("download").textContent = "Download " + exportSettings().label + " ↓";
}

$("format").onchange = exportHint;

function exportFrame(square) {
  if (!circles.length)
    return { x: 0, y: 0, width: 1000, height: 1000 };
  const left = Math.min(...circles.map((c) => c.x - c.r - 0.65)),
    top = Math.min(...circles.map((c) => c.y - c.r - 0.65));
  const width = Math.max(...circles.map((c) => c.x + c.r + 0.65)) - left,
    height = Math.max(...circles.map((c) => c.y + c.r + 0.65)) - top;
  const side = Math.max(width, height);
  return square
    ? {
        x: left - (side - width) / 2,
        y: top - (side - height) / 2,
        width: side,
        height: side,
      }
    : { x: left, y: top, width, height };
}
// Trim the rendered pixels before adding any optional square padding or JPG background.

function cropExportCanvas(source, square, transparent) {
  const sw = source.width,
    sh = source.height,
    pixels = source.getContext("2d").getImageData(0, 0, sw, sh).data;
  let left = sw,
    top = sh,
    right = -1,
    bottom = -1;
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      if (pixels[(y * sw + x) * 4 + 3] === 0)
        continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right < left) {
    left = top = 0;
    right = bottom = 0;
  }
  const width = right - left + 1,
    height = bottom - top + 1,
    side = Math.max(width, height);
  const result = document.createElement("canvas");
  result.width = square ? side : width;
  result.height = square ? side : height;
  const ctx = result.getContext("2d");
  if (!transparent) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, result.width, result.height);
  }
  // Integer placement preserves sharp edges; odd padding differs by at most one pixel.
  ctx.drawImage(
    source,
    left,
    top,
    width,
    height,
    Math.floor((result.width - width) / 2),
    Math.floor((result.height - height) / 2),
    width,
    height,
  );
  return result;
}

// Transient status messages.
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 3000);
}

// Render the diagram to a canvas, crop it, and download the image.
$("exportForm").onsubmit = async (e) => {
  e.preventDefault();
  const { format, transparent } = exportSettings(),
    square =
      document.querySelector('input[name="exportShape"]:checked').value ===
      "square",
    frame = exportFrame(false);
  const scale = 1600 / Math.max(frame.width, frame.height),
    w = Math.max(1, Math.round(frame.width * scale)),
    h = Math.max(1, Math.round(frame.height * scale));
  $("download").disabled = true;
  $("download").textContent = "Preparing…";
  let url;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    // Rasterize the SVG at the chosen export dimensions.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${
      w
    }" height="${
      h
    }" viewBox="${
      frame.x
    } ${
      frame.y
    } ${
      frame.width
    } ${
      frame.height
    }">${
      artwork(false)
    }</svg>`;
    url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, w, h);

    // Crop the image and encode it in the selected format.
    const output = cropExportCanvas(canvas, square, transparent);
    const blob = await new Promise((resolve) =>
      output.toBlob(resolve, transparent ? "image/png" : "image/jpeg", 0.85),
    );
    if (!blob)
      throw Error("Export failed");

    // Download the image and release its temporary URL.
    const out = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = out;
    a.download = `easy-venn${transparent ? "-transparent" : ""}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(out), 60000);
    toast("Your diagram is ready.");
    $("exportDialog").close();
  } catch (err) {
    toast("Export failed. Please try again.");
    console.error(err);
  } finally {
    if (url)
      URL.revokeObjectURL(url);
    $("download").disabled = false;
    exportHint();
  }
};
// #endregion

// Initial render.

render();
