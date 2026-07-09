import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ui";

describe("ConfirmDialog", () => {
  it("requires an explicit confirmation before invoking a destructive action", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(<ConfirmDialog open onOpenChange={() => undefined} title="Delete memory?" description="This cannot be undone." confirmLabel="Delete" destructive onConfirm={confirm} />);

    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Delete memory?");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
