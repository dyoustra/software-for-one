import { createRemoteJWKSet, jwtVerify } from "jose";

/** The app's id, and the web service id the approval page signs in with. */
export const APPLE_AUDIENCES = ["com.youstra.sfo", "com.youstra.sfo.web"];

export interface AppleIdentity {
  /** Apple's stable id for this person, within this team. */
  sub: string;
  email?: string;
}

export type VerifyApple = (idToken: string) => Promise<AppleIdentity>;

const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

/** Checks an identity token was signed by Apple, for this app, and has not expired. */
export const verifyApple: VerifyApple = async (idToken) => {
  const { payload } = await jwtVerify(idToken, appleKeys, { issuer: "https://appleid.apple.com", audience: APPLE_AUDIENCES });
  if (typeof payload.sub !== "string") throw new Error("Apple's token names no one");
  return { sub: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
};
