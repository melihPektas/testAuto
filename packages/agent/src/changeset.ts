import type { ChangedFile } from './review.js';

/**
 * The change under review, normalised from wherever it came — a git diff, a
 * merge-request payload, an explicit list. The reviewer only ever sees this.
 *
 * @public
 */
export interface Changeset {
  readonly files: ChangedFile[];
  readonly title: string | undefined;
  readonly source: string;
  /** A running-environment URL to test against, if the trigger supplied one. */
  readonly targetUrl: string | undefined;
}

/** Parse the file list out of `git diff --numstat` (or `--name-only`). */
export function changesetFromNumstat(numstat: string, title?: string): Changeset {
  const files: ChangedFile[] = [];
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    // `added<TAB>removed<TAB>path`, or just a path from --name-only.
    const parts = trimmed.split('\t');
    if (parts.length >= 3) {
      const added = Number.parseInt(parts[0] ?? '', 10);
      const removed = Number.parseInt(parts[1] ?? '', 10);
      const churn = (Number.isFinite(added) ? added : 0) + (Number.isFinite(removed) ? removed : 0);
      files.push({ path: parts.slice(2).join('\t'), churn });
    } else {
      files.push({ path: trimmed });
    }
  }
  return { files, title, source: 'git', targetUrl: undefined };
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Normalise a GitLab merge-request "changes" payload
 * (`GET /projects/:id/merge_requests/:iid/changes`) into a Changeset. A renamed
 * file reports its new path, since that is what exists to test.
 *
 * @public
 */
export function changesetFromGitlab(payload: unknown): Changeset {
  const root = isDict(payload) ? payload : {};
  const changes = Array.isArray(root['changes']) ? root['changes'] : [];
  const files: ChangedFile[] = [];
  for (const change of changes) {
    if (!isDict(change)) {
      continue;
    }
    const path = str(change['new_path']) ?? str(change['old_path']);
    if (path !== undefined && change['deleted_file'] !== true) {
      files.push({ path });
    }
  }
  return {
    files,
    title: str(root['title']),
    source: 'gitlab',
    // A merge request does not reliably carry the URL of its deployed review
    // app — that lives in a CI variable or environment, not the changes
    // payload — so this is left for the caller to supply rather than guessed.
    targetUrl: undefined,
  };
}

/**
 * Normalise a GitHub pull-request files payload
 * (`GET /repos/:owner/:repo/pulls/:number/files`) into a Changeset.
 *
 * @public
 */
export function changesetFromGithub(files: unknown, title?: string): Changeset {
  const rows = Array.isArray(files) ? files : [];
  const out: ChangedFile[] = [];
  for (const row of rows) {
    if (!isDict(row)) {
      continue;
    }
    const path = str(row['filename']);
    if (path !== undefined && row['status'] !== 'removed') {
      const churn = typeof row['changes'] === 'number' ? row['changes'] : undefined;
      out.push({ path, ...(churn !== undefined ? { churn } : {}) });
    }
  }
  return { files: out, title, source: 'github', targetUrl: undefined };
}

/**
 * Pull the MR/PR identity out of a Jira webhook. Jira does not carry the diff;
 * it carries a link to the branch or merge request, which is the thing to fetch
 * next. Returns whatever the payload actually names — nothing is invented.
 *
 * @public
 */
export interface JiraTrigger {
  readonly issueKey: string | undefined;
  readonly summary: string | undefined;
  readonly status: string | undefined;
  /** Any URL the issue links to — a branch, an MR, a PR. */
  readonly links: string[];
}

export function jiraTrigger(payload: unknown): JiraTrigger {
  const root = isDict(payload) ? payload : {};
  const issue = isDict(root['issue']) ? root['issue'] : {};
  const fields = isDict(issue['fields']) ? issue['fields'] : {};
  const status = isDict(fields['status']) ? fields['status'] : {};

  const links = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
        links.add(match[0]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (isDict(value)) {
      Object.values(value).forEach(scan);
    }
  };
  scan(fields['description']);
  scan(root['comment']);

  return {
    issueKey: str(issue['key']),
    summary: str(fields['summary']),
    status: str(status['name']),
    links: [...links],
  };
}

export interface FetchOptions {
  /** GitLab private token, or the name is read from GITLAB_TOKEN. */
  readonly gitlabToken?: string;
  /** GitHub token, or read from GITHUB_TOKEN. */
  readonly githubToken?: string;
}

/**
 * Fetch a changeset from a merge-request or pull-request URL. Recognises a
 * GitLab MR (`/-/merge_requests/N`) and a GitHub PR (`/pull/N`), derives the
 * API endpoint from the web URL, and returns the normalised changeset. This is
 * the middle link of the Jira → MR → plan chain.
 *
 * The token is read from the environment by default and only ever sent as a
 * request header — never logged, never returned.
 *
 * @public
 */
export async function fetchChangeset(
  url: string,
  options: FetchOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Changeset> {
  const gitlab = /^(https?:\/\/[^/]+)\/(.+)\/-\/merge_requests\/(\d+)/.exec(url);
  if (gitlab !== null) {
    const [, origin, projectPath, iid] = gitlab;
    const token = options.gitlabToken ?? env['GITLAB_TOKEN'];
    const api = `${origin ?? ''}/api/v4/projects/${encodeURIComponent(projectPath ?? '')}/merge_requests/${iid ?? ''}/changes`;
    const response = await fetchImpl(api, {
      headers: token === undefined ? {} : { 'private-token': token },
    });
    if (!response.ok) {
      throw new Error(`GitLab returned HTTP ${String(response.status)} for ${api}`);
    }
    return changesetFromGitlab(await response.json());
  }

  const github = /^(https?:\/\/)(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (github !== null) {
    const [, , owner, repo, number] = github;
    const token = options.githubToken ?? env['GITHUB_TOKEN'];
    const api = `https://api.github.com/repos/${owner ?? ''}/${repo ?? ''}/pulls/${number ?? ''}/files`;
    const response = await fetchImpl(api, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${String(response.status)} for ${api}`);
    }
    return changesetFromGithub(await response.json());
  }

  throw new Error(
    'unrecognised MR/PR url; expected a GitLab merge request or a GitHub pull request',
  );
}
