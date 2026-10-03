import fs from "node:fs";
import http from "node:http";

const SPRITE_SOCKET = "/.sprite/api.sock";

/** How long one renewal holds the Sprite awake: long enough to ride out a few missed beats. */
const HOLD = "5m";

/**
 * Asks the Sprite we are running on not to pause. A Sprite pauses when it sees
 * no activity it recognises, and a stage calling out to a model is not
 * activity it recognises: paused, the stage would freeze mid-call. The hold
 * lapses on its own, so a run that dies stops holding the Sprite awake.
 *
 * Does nothing anywhere but a Sprite, and never throws: staying awake is
 * worth trying every beat, and failing a stage over it is not.
 */
export function holdAwake(id: string, socketPath = SPRITE_SOCKET): void {
  if (!fs.existsSync(socketPath)) return;
  const body = JSON.stringify({ expire: HOLD });
  const req = http.request({
    socketPath,
    host: "sprite",
    path: `/v1/tasks/sfo-${encodeURIComponent(id)}`,
    method: "PUT",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    timeout: 5_000,
  });
  req.on("response", (res) => res.resume());
  req.on("timeout", () => req.destroy());
  req.on("error", () => {});
  req.end(body);
}
