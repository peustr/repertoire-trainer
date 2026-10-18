// Re-render the current page after its data changed. The router in app.js
// registers itself here, so views can refresh without importing app.js.

let render = () => {};

export function setRenderer(fn) {
  render = fn;
}

export function refresh() {
  return render();
}
