module.exports = {
  apps: [{
    name: 'reddit-hide-sync',
    node_args: '--max-old-space-size=96',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3205,
      BASE_PATH: '/reddit-hide'
    },
    max_memory_restart: '150M'
  }]
};
