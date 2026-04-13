const STORAGE_KEY = "aiug_panel_token";

export function getPanelToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setPanelToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearPanelToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
