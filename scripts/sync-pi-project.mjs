#!/usr/bin/env node
// Add open issues from every matching owner repository to the shared project.
// Uses gh authentication. Never reads or stores credential files.
import { execFileSync } from 'node:child_process';

const owner = 'tahabakhit';
const projectNumber = 3;
const prefix = 'pi';
function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }));
}
function query(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push('-f', `${key}=${value}`);
  const result = gh(args);
  if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
const project = query(`query { user(login:"${owner}") { projectV2(number:${projectNumber}) { id fields(first:100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`).user.projectV2;
if (!project) throw new Error('Project not found');
const status = project.fields.nodes.find(field => field.name === 'Status');
const todo = status?.options.find(option => option.name === 'Todo');
if (!todo) throw new Error('Expected Todo status is missing');
const repos = gh(['api', '--paginate', '--slurp', `users/${owner}/repos?per_page=100&type=owner`]).flat()
  .filter(repo => repo.owner.login.toLowerCase() === owner && repo.name.startsWith(prefix));
let added = 0;
let existing = 0;
for (const repo of repos) {
  const issues = gh(['api', '--paginate', '--slurp', `repos/${owner}/${repo.name}/issues?state=open&per_page=100`]).flat().filter(issue => !issue.pull_request);
  for (const issue of issues) {
    const current = query('query($id:ID!) { node(id:$id) { ... on Issue { projectItems(first:100) { nodes { project { id } } pageInfo { hasNextPage } } } } }', { id: issue.node_id }).node.projectItems;
    if (current.nodes.some(item => item.project.id === project.id)) { existing++; continue; }
    if (current.pageInfo.hasNextPage) throw new Error('Issue has too many project memberships; refusing unsafe duplicate inference');
    const item = query('mutation($project:ID!,$issue:ID!) { addProjectV2ItemById(input:{projectId:$project,contentId:$issue}) { item { id } } }', { project: project.id, issue: issue.node_id }).addProjectV2ItemById.item;
    query('mutation($project:ID!,$item:ID!,$field:ID!,$option:String!) { updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}) { projectV2Item { id } } }', { project: project.id, item: item.id, field: status.id, option: todo.id });
    const verified = query('query($id:ID!) { node(id:$id) { ... on ProjectV2Item { project { id } fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }', { id: item.id }).node;
    if (verified.project.id !== project.id || verified.fieldValueByName?.name !== 'Todo') throw new Error(`Failed to verify import of ${issue.html_url}`);
    added++;
    console.log(`Added: ${issue.html_url}`);
  }
  console.log(`Included ${repo.full_name}: ${issues.length} open issues`);
}
console.log(`Prefix ${owner}/${prefix}*: ${repos.length} repositories; ${added} added; ${existing} already present. Existing statuses preserved.`);
