import QRCode from "qrcode-svg";

/** Render a QR code (SVG) for arbitrary text — used by the WeChat share. */
export function renderQr(data: string): Response {
  const content = (data || "").slice(0, 900) || " ";
  const svg = new QRCode({
    content,
    padding: 2,
    width: 232,
    height: 232,
    color: "#111111",
    background: "#ffffff",
    ecl: "M",
    join: true,
  }).svg();
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
