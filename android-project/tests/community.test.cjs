const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/app.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

function setup(posts, confirmResult = true) {
  const storage = new Map([['gygj_user_id', 'me'], ['gygj_community', JSON.stringify(posts)]]);
  const elements = new Map();
  const messages = [];
  const context = {
    window: {}, console, confirm: () => confirmResult,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: {
      addEventListener() {}, querySelectorAll: () => [],
      createElement: () => ({ textContent: '', get innerHTML() { return this.textContent; } }),
      getElementById(id) { if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '' }); return elements.get(id); }
    }
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  context.showToast = message => messages.push(message);
  return { context, storage, elements, messages };
}

const legacyPost = () => ({ id: 'post', user: 'other', role: 'worker', tag: 'daily', content: 'test', likes: 0, comments: [{ user: '\u6211', text: 'mine' }, { user: 'other', text: 'theirs' }] });

test('legacy own comments receive stable IDs and can be deleted without deleting others', () => {
  const { context, storage } = setup([legacyPost()]);
  const posts = context.getPosts();
  const own = posts[0].comments[0];
  assert.equal(own.authorId, 'me');
  assert.equal(own.id, context.getPosts()[0].comments[0].id);
  context.deleteComment('post', own.id);
  const saved = JSON.parse(storage.get('gygj_community'));
  assert.equal(saved[0].comments.length, 1);
  assert.equal(saved[0].comments[0].text, 'theirs');
});

test('cancelled deletion preserves the record', () => {
  const { context, storage } = setup([legacyPost()], false);
  const before = storage.get('gygj_community');
  context.deleteComment('post', context.getPosts()[0].comments[0].id);
  assert.equal(storage.get('gygj_community'), before);
});

test('another user comment cannot be deleted even if its display name is me', () => {
  const post = legacyPost();
  post.comments[0].authorId = 'another-user';
  const { context, storage } = setup([post]);
  const before = storage.get('gygj_community');
  context.deleteComment('post', context.getPosts()[0].comments[0].id);
  assert.equal(storage.get('gygj_community'), before);
});

test('new comments persist identity and only own comments render a delete control', () => {
  const { context, elements } = setup([{ ...legacyPost(), comments: [{ user: 'other', text: 'theirs' }] }]);
  context.document.getElementById('comment-post').value = 'new comment';
  context.addComment('post');
  const comment = context.getPosts()[0].comments[1];
  assert.ok(comment.id.startsWith('c'));
  assert.equal(comment.authorId, 'me');
  assert.equal((elements.get('community-feed').innerHTML.match(/data-comment-id=/g) || []).length, 1);
});

test('own post can be deleted while other posts remain', () => {
  const own = { ...legacyPost(), id: 'mine', user: '\u6211' };
  const { context, storage } = setup([own, legacyPost()]);
  context.deleteCommunityPost('mine');
  assert.deepEqual(JSON.parse(storage.get('gygj_community')).map(post => post.id), ['post']);
});
