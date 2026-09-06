/** Lower-case, accent-stripped text for searching ("Zürich" matches "zurich"). */
export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
