import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VersionLink } from "./layout";

describe("VersionLink", () => {
  it("links the build version to the source repository", () => {
    render(<VersionLink />);

    const link = screen.getByRole("link", { name: "dev" });
    expect(link).toHaveAttribute("href", "https://github.com/chrisstoll1/plex-repair-discord-bot");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
