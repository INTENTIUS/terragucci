/**
 * terragucci's logo, the pixel-art taco, for the pages terragucci writes
 * (report.html, the report index, the estate page). The 51x31 art is inlined
 * as a PNG data URI so each page stays one self-contained file; the pages'
 * Content-Security-Policy allows data: images. Shown at its own size with
 * image-rendering: pixelated, each art pixel stays a sharp square.
 */
export const TACO_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAfCAMAAAB9EQVVAAAAVFBMVEUAAAAJtroqIiI2PCVaNBNdjApk09N9KhGKSxmSbj6W4eOjZyOlyhC06ee4Ski8Gg7U727Wm0DZ9vbbqljcDwjnj4LnwSr0lQr0wmr21pv22Qf39/d/Xc1TAAAAAXRSTlMAQObYZgAAAa1JREFUeNqNlIF2gyAMRSUD5la7GWZXnf//n3uBIKC2p++cUqq5vCRAu+4ggvLYpfGZJJAGSMeO4vgUGSEanBuStgUemEWL0QEQDYNwMlGeHllIpLOtBHenDDze0sJgllrAziGKHlgUH5bIeVPEsNS+JBolZXv7SsTMG8FK/WDRlhLGvk/TFNMqRG01to2INmBiJYihRnjQzwujLNkvqm2mb0HweiYvMuu6GpmQZolWyHZRZlzscCodSAjBryKDidkgaYUy2Ep0035kBHE+IeJkQnFClCPNjMhpKRFB6BoydL1WkJ0yIlvJWr6PWZmMCFOc7HSLkNgMxQalhIoBIFKIsR13yo3mvPVkoj4VuaafxKxGf3+UO83baZFOY+GgNmh6QQAlBn0btM0XdfK5cTKrkdne0+1NR6YclZheiDl5TYz16OGlGAG52RpJkE+1N4nVDNl4ZhooMQekMLBpjAB5tdHEyuWgXzA9mO2u5G8yidm5MJgFzNJTa1KO3R6JPqeMpie7r0gGLw3Tn0FHF2UA0XJmNJ8hM3M6B3zhnQ4Pyot8T/l1UfO/+5ok/B+M50/N53uHFAAAAABJRU5ErkJggg==";

/** The favicon link a page's head carries. */
export const TACO_ICON = `<link rel="icon" type="image/png" href="${TACO_PNG}">`;

/** The taco beside a page's heading; decorative, since the heading names the page. */
export const TACO_IMG = `<img class="taco" src="${TACO_PNG}" width="51" height="31" alt="">`;

/** CSS for a heading that leads with the taco. */
export const TACO_CSS = "h1.brand{display:flex;align-items:center;gap:10px}.taco{image-rendering:pixelated;flex:none}";

/** Where the site publishes the small taco a forge note shows: 52x32, drawn at 26x16. */
export const TACO_NOTE_URL = "https://intentius.io/terragucci/brand/taco-small.png";
