import { ConfigError, mergeDeep } from "./config.js";

/**
 * Named environments (dev, uat, prod, …) and the users to log in to them as.
 *
 * Everything can come from environment variables, which is how CI hands over
 * secrets without a config file:
 *
 *   ENVDIFF_<ENV>_URL                              where the environment lives
 *   ENVDIFF_<ENV>_USERNAME, ENVDIFF_<ENV>_PASSWORD  its default user
 *   ENVDIFF_<ENV>_<USER>_USERNAME, …_PASSWORD       another user, picked with --user <user>
 *   ENVDIFF_<ENV>[_<USER>]_TOTP                     authenticator secret, when the login asks for a one-time code
 *   ENVDIFF_BASELINE_USERNAME / _PASSWORD / _TOTP   per side; override all of the above
 *   ENVDIFF_CANDIDATE_USERNAME / _PASSWORD / _TOTP
 *
 * <ENV> and <USER> are upper-cased, with anything but letters and digits
 * turned into "_": user "qa-admin" on "uat" is ENVDIFF_UAT_QA_ADMIN_USERNAME.
 */

/** The variable-name form of an environment or user name. @param {string} name */
export function envKey(name) {
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const RESERVED = new Set(["BASELINE", "CANDIDATE"]);

/**
 * Environment names that can be used in place of a URL: those in the config
 * file and those with an ENVDIFF_<ENV>_URL variable.
 * @param {Record<string, any> | undefined} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>} lower-case names
 */
export function knownEnvironments(configured, env = process.env) {
  const names = new Set(Object.keys(configured ?? {}).map((n) => n.toLowerCase()));
  for (const [k, v] of Object.entries(env)) {
    const m = /^ENVDIFF_([A-Z0-9_]+)_URL$/.exec(k);
    if (m && v && !RESERVED.has(m[1])) names.add(m[1].toLowerCase());
  }
  return names;
}

/**
 * The config entry for a named environment, matched without regard to case.
 * @param {Record<string, any> | undefined} environments
 * @param {string} name
 */
function entryFor(environments, name) {
  if (!environments) return undefined;
  const k = Object.keys(environments).find((n) => n.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : environments[k];
}

/**
 * Hide most of a username for reports and logs: "qa.lead@example.com" ->
 * "q…d@example.com".
 * @param {string} username
 */
export function maskUsername(username) {
  const s = String(username ?? "");
  const at = s.indexOf("@");
  const local = at > 0 ? s.slice(0, at) : s;
  const domain = at > 0 ? s.slice(at) : "";
  const shown = local.length <= 2 ? `${local[0] ?? ""}…` : `${local[0]}…${local[local.length - 1]}`;
  return shown + domain;
}

/**
 * @typedef {object} Credentials
 * @property {string} username
 * @property {string} password
 * @property {string} [totp] Base32 authenticator secret.
 * @property {string} user The user's name ("default" for the default user).
 * @property {string} source Where they came from, for messages: never the values.
 */

/**
 * Find the credentials for one side.
 * @param {object} o
 * @param {"baseline"|"candidate"} o.side
 * @param {string | undefined} o.envName
 * @param {string | null | undefined} o.user
 * @param {any} o.entry The environment's config entry.
 * @param {NodeJS.ProcessEnv} o.env
 * @returns {Credentials | null}
 */
export function credentialsFor({ side, envName, user, entry, env }) {
  const userName = user && String(user).trim() ? String(user).trim() : "default";
  /** @param {string} prefix */
  const fromVars = (prefix) => {
    const username = env[`${prefix}USERNAME`];
    const password = env[`${prefix}PASSWORD`];
    if (!username && !password) return null;
    if (!username) throw new ConfigError(`${prefix}PASSWORD is set but ${prefix}USERNAME is not`);
    if (!password) throw new ConfigError(`${prefix}USERNAME is set but ${prefix}PASSWORD is not`);
    return { username, password, totp: env[`${prefix}TOTP`] || undefined, user: userName, source: `${prefix}*` };
  };
  const perSide = fromVars(`ENVDIFF_${side.toUpperCase()}_`);
  if (perSide) return perSide;
  if (envName) {
    const prefix = userName === "default" ? `ENVDIFF_${envKey(envName)}_` : `ENVDIFF_${envKey(envName)}_${envKey(userName)}_`;
    const vars = fromVars(prefix);
    if (vars) return vars;
    const users = entry?.users ?? {};
    const configured = Object.entries(users).find(([n]) => n.toLowerCase() === userName.toLowerCase())?.[1];
    if (configured) {
      if (!configured.username || !configured.password) {
        throw new ConfigError(`environments.${envName}.users.${userName} needs a username and a password`);
      }
      return { username: String(configured.username), password: String(configured.password), totp: configured.totp, user: userName, source: `environments.${envName}.users.${userName}` };
    }
    if (userName !== "default") {
      throw new ConfigError(`No login for user "${userName}" on ${envName}: set ${prefix}USERNAME and ${prefix}PASSWORD`);
    }
    return null;
  }
  if (userName !== "default") {
    const S = side.toUpperCase();
    throw new ConfigError(`--user ${userName} needs a named environment (e.g. uat) or ENVDIFF_${S}_USERNAME and ENVDIFF_${S}_PASSWORD`);
  }
  return null;
}

/**
 * Fill in each side from its named environment, and attach the login to use.
 * Run after the config files and command line are merged.
 * @param {any} cfg
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyEnvironments(cfg, env = process.env) {
  for (const side of /** @type {const} */ (["baseline", "candidate"])) {
    /** @type {any} */
    let s = cfg[side] ?? {};
    const envName = s.env ? String(s.env) : undefined;
    const entry = envName ? entryFor(cfg.environments, envName) ?? {} : undefined;
    if (envName) {
      const url = s.url ?? entry.url ?? env[`ENVDIFF_${envKey(envName)}_URL`];
      if (!url && !s.ref && !entry.ref) {
        throw new ConfigError(`Environment "${envName}" has no address: set ENVDIFF_${envKey(envName)}_URL or environments.${envName}.url`);
      }
      const { users: _users, ...rest } = entry;
      s = mergeDeep(rest, s);
      if (url && !s.ref) s.url = url;
      s.label ??= envName;
    }
    const user = s.user ?? cfg.user;
    const auth = s.auth ?? entry?.auth ?? cfg.auth;
    if (user && String(user).toLowerCase() === "none") {
      s.auth = undefined;
      s.login = null;
      cfg[side] = s;
      continue;
    }
    const creds = credentialsFor({ side, envName, user, entry, env });
    if (creds) {
      s.auth = { ...(auth ?? {}), username: creds.username, password: creds.password, totp: creds.totp ?? auth?.totp };
      s.login = { user: creds.user, username: maskUsername(creds.username), source: creds.source, totpVar: creds.source.replace(/\*$/, "TOTP") };
    } else if (auth) {
      s.auth = auth;
      const named = auth.username ? maskUsername(String(auth.username)) : null;
      s.login = { user: "default", username: named, source: auth.steps?.length ? "auth.steps" : "auth" };
      if (!auth.steps?.length && (!auth.username || !auth.password)) {
        const where = envName ? `ENVDIFF_${envKey(envName)}_USERNAME and ENVDIFF_${envKey(envName)}_PASSWORD` : `ENVDIFF_${side.toUpperCase()}_USERNAME and ENVDIFF_${side.toUpperCase()}_PASSWORD`;
        throw new ConfigError(`A login is configured for ${s.label ?? side} but no credentials were given: set ${where}, or auth.steps`);
      }
    } else {
      s.login = null;
    }
    cfg[side] = s;
  }
  return cfg;
}
