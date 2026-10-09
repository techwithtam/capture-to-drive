import { describe, expect, it } from 'vitest';
import config from '../wxt.config';

describe('capture permissions', () => {
  it('permits restricted-page screenshots after the user invokes the extension', () => {
    expect(config).toEqual(expect.objectContaining({
      manifest: expect.objectContaining({
        permissions: expect.arrayContaining(['activeTab', 'scripting']),
        host_permissions: ['<all_urls>'],
      }),
    }));
  });
});
