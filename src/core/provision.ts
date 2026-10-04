import { randomBytes } from "node:crypto";
import type { SpriteCli } from "./sprite.js";

/** Where every new Sprite gets sfo from. A Sprite runs what is on main. */
export const SFO_REPO = "https://github.com/dyoustra/software-for-one.git";

/**
 * Prepares a new Sprite to run sfo. Claude Code comes from its own installer:
 * the copy a Sprite ships with lags and cannot update itself while its
 * launcher is in the way. sfo is cloned from main.
 */
const SETUP = `set -e
if ! readlink ~/.local/bin/claude 2>/dev/null | grep -q /claude/versions/; then
  mv -f ~/.local/bin/claude ~/.local/bin/claude.sprite-wrapper 2>/dev/null || true
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null
fi
rm -rf ~/sfo && git clone -q --depth 1 "$1" ~/sfo
cd ~/sfo && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run -s build >/dev/null
ln -sf ~/sfo/dist/cli.js ~/.local/bin/sfo
cat > ~/.sfo-env <<'EOF'
export SFO_CONFINEMENT=vm
[ -r ~/.config/sfo/claude-token ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/sfo/claude-token)"
[ -r ~/.config/sfo/api-key ] && export ANTHROPIC_API_KEY="$(cat ~/.config/sfo/api-key)"
EOF
for f in ~/.profile ~/.bashrc; do grep -q sfo-env "$f" 2>/dev/null || echo 'source ~/.sfo-env' >> "$f"; done
mkdir -p ~/.sfo && printf '%s\\n' "$2" > ~/.sfo/profile.json
git config --global user.name sfo && git config --global user.email sfo@localhost
claude --version >/dev/null && sfo --version >/dev/null`;

/** Stores one secret on the Sprite, readable only by its user. It travels on stdin, never in arguments. */
const STORE_SECRET = `umask 077; mkdir -p ~/.config/sfo; cat > ~/.config/sfo/"$1"`;

/** The few GitHub calls a project repo needs. */
export interface GitHub {
  login(token: string): Promise<string>;
  createPrivateRepo(token: string, name: string, description: string): Promise<string>;
  /** A key with write access to this one repo and no other. */
  addDeployKey(token: string, owner: string, repo: string, publicKey: string): Promise<void>;
}

export const github: GitHub = {
  async login(token) {
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub refused the token (${r.status})`);
    return ((await r.json()) as { login: string }).login;
  },
  async createPrivateRepo(token, name, description) {
    const r = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ name, description, private: true }),
    });
    if (!r.ok) throw new Error(`GitHub would not create ${name} (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { html_url: string }).html_url;
  },
  async addDeployKey(token, owner, repo, publicKey) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ title: "sfo Sprite", key: publicKey, read_only: false }),
    });
    if (!r.ok) throw new Error(`GitHub would not add a deploy key to ${repo} (${r.status}): ${(await r.text()).slice(0, 200)}`);
  },
};

/** A credential a Sprite pays for model calls with, and which method it is. */
export interface SpriteCredential {
  file: "claude-token" | "api-key";
  value: string;
  method: "claude_subscription" | "anthropic_api_key";
}

/** Everything a new project's Sprite is given; where it comes from is the caller's business. */
export interface ProvisionSpec {
  idea: string;
  budget?: string;
  run: boolean;
  credentials: SpriteCredential[];
  /** The profile sfo on the Sprite runs with: which of `credentials` it prefers. */
  profileJson: string;
  preferencesJson: string;
  sfoMd: string | null;
  githubToken: string | null;
}

export interface Provisioned {
  id: string;
  sprite: string;
  repo: string | null;
  started: boolean;
}

/**
 * Captures an idea on a new Sprite of its own: created, set up, given its
 * credentials and the person's preferences, captured, optionally given a
 * private repo, and started. A Sprite whose capture fails is destroyed.
 */
export async function provisionProject(
  spec: ProvisionSpec,
  deps: { cli: SpriteCli; github?: GitHub; log?: (message: string) => void },
): Promise<Provisioned> {
  const log = deps.log ?? console.log;
  const cli = deps.cli;
  const sprite = `sfo-${randomBytes(4).toString("hex")}`;
  log(`creating Sprite ${sprite} and setting it up (about a minute)`);
  await cli.create(sprite);
  let id: string | null = null;
  let triage = "";
  try {
    const setup = await cli.exec(sprite, SETUP, [process.env.SFO_REPO_URL || SFO_REPO, spec.profileJson]);
    if (setup.status !== 0) throw new Error(`setting up ${sprite} failed: ${setup.stdout.trim().split("\n").slice(-3).join(" ")}`);
    for (const c of spec.credentials) {
      if ((await cli.exec(sprite, STORE_SECRET, [c.file], { input: c.value })).status !== 0) throw new Error(`could not store the credential on ${sprite}`);
    }
    // Where `sfo new` on the Sprite snapshots them from.
    for (const [file, text] of [["preferences.json", spec.preferencesJson], ["SFO.md", spec.sfoMd]] as const) {
      if (text?.trim() && (await cli.exec(sprite, `cat > ~/.sfo/"$1"`, [file], { input: text })).status !== 0) {
        throw new Error(`could not copy the ${file} to ${sprite}`);
      }
    }

    // On its own Sprite the project is local; without --local, sfo there would
    // try to make yet another Sprite.
    const captured = await cli.exec(sprite, `cd ~ && exec sfo new "$@"`, [spec.idea, "--local", "--no-run", ...(spec.budget ? ["--budget", spec.budget] : [])]);
    triage = captured.stdout;
    log(captured.stdout.trim().replace(/not started — `sfo run [^`]+` when you are ready\n?/, ""));
    id = captured.stdout.match(/^captured: (\S+)/m)?.[1] ?? null;
    if (captured.status !== 0 || !id) throw new Error("capture failed on the Sprite");
  } catch (err) {
    // Nothing on it is worth keeping yet, and nothing else would ever remove it.
    await cli.destroy(sprite);
    throw err;
  }

  let repo: string | null = null;
  if (spec.githubToken) {
    try {
      repo = await connectRepo(id, sprite, spec.githubToken, cli, deps.github ?? github);
      log(`private repo: ${repo}`);
    } catch (err) {
      log(`no GitHub repo for this project — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Starting what triage called out of scope spends money on something it
  // just said this cannot build; the person decides with `sfo run`.
  const started = spec.run && !/triage: out of scope/.test(triage);
  if (started) {
    await cli.exec(sprite, `exec sfo run "$1"`, [id]);
    log(`started on ${sprite}`);
  }
  return { id, sprite, repo, started };
}

/**
 * Creates the project's private repo and lets its Sprite push to it. The
 * person's token never leaves this machine: everything on a Sprite is readable
 * by the agents that run there, and that token reaches every repo they own.
 * The Sprite instead makes a key of its own, allowed to push to this repo and
 * nothing else.
 */
async function connectRepo(id: string, sprite: string, token: string, cli: SpriteCli, gh: GitHub): Promise<string> {
  const owner = await gh.login(token);
  const page = await gh.createPrivateRepo(token, id, "Built by sfo");
  const keygen = `set -e; mkdir -p ~/.ssh; chmod 700 ~/.ssh; rm -f ~/.ssh/sfo_deploy ~/.ssh/sfo_deploy.pub
ssh-keygen -q -t ed25519 -N "" -C "sfo $1" -f ~/.ssh/sfo_deploy; cat ~/.ssh/sfo_deploy.pub`;
  const made = await cli.exec(sprite, keygen, [id]);
  if (made.status !== 0) throw new Error("could not make a deploy key on the Sprite");
  await gh.addDeployKey(token, owner, id, made.stdout.trim());
  const wire = `cd ~/.sfo/"$1" && git remote add origin "$2" \
  && git config core.sshCommand "ssh -i ~/.ssh/sfo_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  && git push -q -u origin HEAD`;
  if ((await cli.exec(sprite, wire, [id, `git@github.com:${owner}/${id}.git`])).status !== 0) throw new Error("could not push to the new repo");
  return page;
}
