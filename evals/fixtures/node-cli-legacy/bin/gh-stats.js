#!/usr/bin/env node
const program = require('commander');
const request = require('request');
const chalk = require('chalk');
const moment = require('moment');

program
  .command('repo <owner/name>')
  .description('show basic repo stats')
  .action((slug) => {
    request({ url: `https://api.github.com/repos/${slug}`, json: true, headers: { 'user-agent': 'gh-stats' } }, (err, res, body) => {
      if (err) { console.error(chalk.red(err.message)); process.exit(1); }
      console.log(chalk.bold(body.full_name), '★', body.stargazers_count, 'updated', moment(body.pushed_at).fromNow());
    });
  });

program.parse(process.argv);
