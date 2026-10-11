import { createFileRoute } from "@tanstack/react-router";
import { HexScroll } from "@/components/hex-scroll";

export const Route = createFileRoute("/video")({
  head: () => ({ meta: [
    { title: "PetroGrid — Video Showcase" },
    { name: "description", content: "PetroGrid's video showcase in its signature hexagonal lattice." },
    { property: "og:title", content: "PetroGrid — Video Showcase" },
    { property: "og:description", content: "The PetroGrid video aperture, ready for the final film." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: VideoPage,
});

function VideoPage() {
  return <main className="identity-study identity-video"><HexScroll /></main>;
}