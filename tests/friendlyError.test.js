import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../src/lib/friendlyError.ts';

test('what the database, the browser and the servers say becomes a plain sentence', () => {
  assert.match(friendlyError(new TypeError('Failed to fetch')), /couldn't be reached/);
  assert.match(friendlyError({ message: 'JWT expired' }), /sign-in has expired/);
  assert.match(friendlyError({ message: 'new row violates row-level security policy for table "matter_notes"' }), /permission/);
  assert.match(friendlyError(new Error('Request failed (500)')), /Hub's side/);
  assert.match(friendlyError(new Error('Invalid login credentials')), /don't match/);
  assert.match(friendlyError({ message: 'duplicate key value violates unique constraint "clients_name_key"' }), /already exists/);
  assert.match(friendlyError({ message: 'update or delete on table "document_types" violates foreign key constraint' }), /still in use/);
});

test('a message already in plain words is kept; system words are not shown', () => {
  assert.equal(friendlyError(new Error('The zip is larger than 30 MB.')), 'The zip is larger than 30 MB.');
  assert.equal(friendlyError(new Error('Only an administrator can remove a file from the library.')), 'Only an administrator can remove a file from the library.');
  assert.equal(friendlyError(new Error('Could not find the function public.foo_bar(x) in the schema cache')), friendlyError(null));
  assert.equal(friendlyError(new Error('column matter_parties.role does not exist')), friendlyError(null));
});

test('nothing to go on gives the fallback, which a caller may set', () => {
  assert.match(friendlyError(undefined), /Something went wrong/);
  assert.equal(friendlyError('', 'Try again.'), 'Try again.');
  assert.equal(friendlyError(new Error('PGRST116'), 'Not found.'), 'Not found.');
});
