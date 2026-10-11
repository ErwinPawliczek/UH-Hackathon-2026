import { createFileRoute } from "@tanstack/react-router";
import { HexScroll } from "@/components/hex-scroll";

export const Route = createFileRoute("/qr")({
  head: () => ({ meta: [
    { title: "PetroGrid — Scan to Visit" },
    { name: "description", content: "Scan to open the PetroGrid demo or main page." },
    { property: "og:title", content: "PetroGrid — Scan to Visit" },
    { property: "og:description", content: "QR codes for the PetroGrid demo and main page." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: QrPage,
});

function QrPage() {
  return (
    <main className="identity-study identity-qr">
      <HexScroll mode="qr" />
    </main>
  );
}
