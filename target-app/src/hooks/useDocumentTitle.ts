import { useEffect } from "react";

export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · RFCU Member Services`;
  }, [title]);
}
