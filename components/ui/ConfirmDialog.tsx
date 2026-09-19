"use client";

import type { ReactNode } from "react";

import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * The question window.confirm() used to ask, in the app's own voice.
 *
 * Control flow is deliberately identical to the two window.confirm() sites it
 * replaces: render it, and act when it says yes.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
            loading={pending}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
