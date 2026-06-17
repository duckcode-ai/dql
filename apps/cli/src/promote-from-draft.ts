import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CLIFlags } from './args.js';

export interface PromoteResult {
  ok: boolean;
  message: string;
  /** The path the draft moved to (relative to projectRoot). */
  certifiedPath?: string;
  /** The patch the human still needs to apply to datalex-manifest.json. */
  datalexManifestDiff?: string;
}

/**
 * Promote a Tier-2 draft block from `blocks/_drafts/<slug>.dql` to the
 * canonical `blocks/<domain>/<slug>.dql` location, flipping `status` to
 * `certified` and setting the `datalex_contract` reference.
 *
 * Companion to the dql-mcp `query_via_metadata` tool. Together they close
 * the graduated-trust promotion loop:
 *
 *   ask  ->  no Tier-1 hit  ->  query_via_metadata writes a draft
 *        ->  human reviews / refines
 *        ->  dql certify --from-draft <path>
 *        ->  next ask hits Tier-1 forever
 *
 * Behavior:
 *   1. Validates the draft exists, has status=draft, and has proposal
 *      metadata such as `proposed_contract_id = ...`.
 *   2. Moves the file to blocks/<domain>/<slug>.dql.
 *   3. Flips `status = "draft"` to `status = "certified"`.
 *   4. Sets `datalex_contract = "<contract>"` (provided via --contract or
 *      taken from `proposed_contract_id` with `@1` appended).
 *   5. Sets `owner = "<owner>"` from --owner if provided.
 *   6. Drops Tier-2 proposal metadata fields (their job is done).
 *   7. Computes the patch the human still needs to apply to
 *      datalex-manifest.json (or surfaces it for --open-pr).
 *
 * Does NOT auto-modify datalex-manifest.json. That file is hand-curated
 * until the DataLex compiler ships its v1 emitter; this command shows
 * the user the exact diff to apply.
 */
export function promoteFromDraft(
  projectRoot: string,
  flags: CLIFlags,
): PromoteResult {
  const draftPathInput = flags.fromDraft!;
  const draftAbs = resolve(projectRoot, draftPathInput);

  if (!existsSync(draftAbs)) {
    return { ok: false, message: `Draft not found at ${draftPathInput}.` };
  }

  const content = readFileSync(draftAbs, 'utf-8');
  if (!/status\s*=\s*"draft"/.test(content)) {
    return {
      ok: false,
      message:
        `${draftPathInput} does not have status="draft". Use dql certify <path> (without --from-draft) to evaluate governance rules.`,
    };
  }

  const proposedContractId = pickField(content, 'proposed_contract_id') ?? '';
  const contract = flags.contract || (proposedContractId ? `${proposedContractId}@1` : '');
  if (!contract) {
    return {
      ok: false,
      message:
        'No --contract <id@version> provided and no proposed_contract_id in the draft. ' +
        'Either pass --contract commerce.Customer.foo@1 or restore proposed_contract_id.',
    };
  }

  const domain = flags.domain || pickField(content, 'proposed_domain') || guessDomain(contract);
  if (!domain) {
    return {
      ok: false,
      message: 'No --domain provided and could not infer one from the contract id.',
    };
  }

  const slug = inferSlugFromPath(draftAbs);
  const destAbs = join(projectRoot, 'blocks', domain, `${slug}.dql`);

  if (existsSync(destAbs) && !flags.force) {
    return {
      ok: false,
      message:
        `${shortPath(projectRoot, destAbs)} already exists. ` +
        'Pass --force to overwrite, or rename the draft.',
    };
  }

  const promoted = renderPromoted(content, {
    contract,
    domain,
    owner: flags.owner || pickField(content, 'owner') || '',
  });

  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, promoted);
  // The draft and the certified copy must not coexist. Drop the draft now
  // that the certified file is on disk.
  unlinkSync(draftAbs);

  const datalexManifestDiff = renderDataLexManifestDiff({
    contract,
    domain,
    slug,
    description: pickField(content, 'description') ?? '',
  });

  return {
    ok: true,
    message: `Promoted ${shortPath(projectRoot, draftAbs)} -> ${shortPath(projectRoot, destAbs)}.`,
    certifiedPath: shortPath(projectRoot, destAbs),
    datalexManifestDiff,
  };
}

// -- helpers ---------------------------------------------------------------

function pickField(content: string, key: string): string | undefined {
  const m =
    content.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) ||
    content.match(new RegExp(`${key}\\s*=\\s*"""([\\s\\S]*?)"""`));
  return m?.[1]?.trim();
}

function guessDomain(contractId: string): string | null {
  const head = contractId.split('.')[0];
  return head && head !== contractId ? head : null;
}

function inferSlugFromPath(absPath: string): string {
  return absPath.replace(/.*\//, '').replace(/\.dql$/, '');
}

function shortPath(projectRoot: string, abs: string): string {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return abs.startsWith(root) ? abs.slice(root.length) : abs;
}

function renderPromoted(
  source: string,
  fields: { contract: string; domain: string; owner: string },
): string {
  let out = source;

  // Flip status.
  out = out.replace(/status\s*=\s*"draft"/, 'status = "certified"');

  // Set domain (overwrite the existing one).
  out = out.replace(/(domain\s*=\s*)"[^"]*"/, `$1"${fields.domain}"`);

  // Set datalex_contract. The draft template ships an empty value
  // (`datalex_contract = ""`); replace with the provided id@version.
  out = out.replace(/datalex_contract\s*=\s*"[^"]*"/, `datalex_contract = "${fields.contract}"`);

  // Set owner if provided + the field exists in the file.
  if (fields.owner) {
    if (/owner\s*=\s*"[^"]*"/.test(out)) {
      out = out.replace(/owner\s*=\s*"[^"]*"/, `owner = "${fields.owner}"`);
    } else {
      // Insert owner right after the status line.
      out = out.replace(
        /(status\s*=\s*"certified"\s*\n)/,
        `$1    owner = "${fields.owner}"\n`,
      );
    }
  }

  // Drop Tier-2 provenance metadata. Its job is done; the certified block is
  // the new source of truth and should not carry capture metadata.
  out = out.replace(/\n\s*_proposed\s*\{[^}]*\}\s*\n/, '\n');
  out = out.replace(/\n\s*(asked_times|first_asked|last_asked|proposed_contract_id|proposed_domain|proposed_entity|upstream_refs)\s*=\s*(?:"[^"]*"|"""[\s\S]*?"""|\d+|\[[^\]]*\])\s*/g, '\n');

  return out;
}

function renderDataLexManifestDiff(fields: {
  contract: string;
  domain: string;
  slug: string;
  description: string;
}): string {
  const [contractId, versionStr] = fields.contract.split('@');
  const version = Number.parseInt(versionStr ?? '1', 10) || 1;
  const parts = contractId.split('.');
  const datalexDomain = parts[0] ?? fields.domain;
  const entity = parts[1] ?? 'Unknown';
  const contractName = parts[2] ?? fields.slug;
  const safeDesc = fields.description.replace(/"/g, '\\"').replace(/\n/g, ' ');

  return `Add the following entry under domains[name=${datalexDomain}].entities[name=${entity}].contracts in datalex-manifest.json:

  {
    "id": "${contractId}",
    "name": "${contractName}",
    "version": ${version},
    "description": "${safeDesc}",
    "signature": {
      "inputs": [],
      "outputs": []
    },
    "owner": "<owner>",
    "tags": []
  }

Then re-run \`dql compile\` to refresh dql-manifest.json. The DataLex compiler
will emit this entry automatically once the v1 manifest emitter ships;
until then, hand-edit \`datalex-manifest.json\` (or its source YAML) so the
DQL block's datalex_contract reference resolves.
`;
}
