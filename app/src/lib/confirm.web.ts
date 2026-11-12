/** Asks before something destructive. React Native's Alert does nothing on the web, so the browser asks. */
export async function confirm(title: string, message: string, _action: string): Promise<boolean> {
  return window.confirm(`${title}\n\n${message}`);
}
