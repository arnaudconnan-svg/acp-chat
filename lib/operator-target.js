'use strict';
function planOperation({ operation, args = [], manifest = null } = {}) {
  if (args.includes('--apply')) throw new Error('real_execution_locked_m0_m1');
  const value = (key) =>
    args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const target = value('target'),
    principal = value('principal'),
    scope = value('scope');
  const ids = (value('ids') || '').split(',').filter(Boolean);
  if (
    !manifest ||
    manifest.version !== 1 ||
    !target ||
    !principal ||
    target !== manifest.databaseUrl ||
    principal !== manifest.principal ||
    !manifest.projectId ||
    !manifest.operations?.includes(operation)
  )
    throw new Error('unknown_or_unattested_operator_target');
  const url = new URL(target);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !principal.endsWith(`@${manifest.projectId}.iam.gserviceaccount.com`)
  )
    throw new Error('invalid_operator_target');
  if (
    !manifest.scopes?.includes(scope) ||
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error('unbounded_operator_scope');
  return {
    operation,
    simulation: true,
    target,
    principal,
    projectId: manifest.projectId,
    paths: [...new Set(ids)].map((id) => `${scope}/${id}`)
  };
}
function operatorMain(
  operation,
  args = process.argv.slice(2),
  env = process.env
) {
  let manifest = null;
  try {
    manifest = JSON.parse(env.OPERATOR_TARGET_MANIFEST || 'null');
  } catch {}
  const plan = planOperation({ operation, args, manifest });
  console.log(JSON.stringify(plan));
  return plan;
}
module.exports = { planOperation, operatorMain };
