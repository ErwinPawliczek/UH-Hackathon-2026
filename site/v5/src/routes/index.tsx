import { createFileRoute } from "@tanstack/react-router";
import { HexScroll } from "@/components/hex-scroll";
import "@/video-placeholder.css";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "PetroGrid — Video" },
    { name: "description", content: "PetroGrid's video showcase, framed by its signature hexagonal lattice." },
    { property: "og:title", content: "PetroGrid — Video" },
    { property: "og:description", content: "PetroGrid's video showcase, framed by its signature hexagonal lattice." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: Index,
});
function Index() {
  return <main className="identity-study identity-video"><HexScroll /></main>;
}
