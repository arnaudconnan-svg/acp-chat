const DEPLOYED_GIT_COMMIT_UNAVAILABLE = 'unavailable';

function buildHealthPayload(env = process.env) {
  const deployedGitCommit = env.RENDER_GIT_COMMIT;

  return {
    status: 'ok',
    gitCommit:
      typeof deployedGitCommit === 'string' && deployedGitCommit.length > 0
        ? deployedGitCommit
        : DEPLOYED_GIT_COMMIT_UNAVAILABLE
  };
}

function createHealthHandler(env = process.env) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(buildHealthPayload(env));
  };
}

module.exports = {
  buildHealthPayload,
  createHealthHandler,
  DEPLOYED_GIT_COMMIT_UNAVAILABLE
};
