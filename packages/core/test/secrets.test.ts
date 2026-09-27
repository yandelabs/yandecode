import { describe, expect, it } from 'vitest';
import { findSecrets } from '@core/security/secrets';

describe('findSecrets', () => {
  it.each([
    ['aws access key', 'export AWS_ACCESS_KEY_ID=AKIAZ3MSJV4WAX7KQ2PL'],
    ['github token', 'git clone https://ghp_1234567890abcdefghijABCDEFGHIJ123456@github.com/x/y'],
    ['anthropic key', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    ['openai key', 'key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'],
    ['slack token', 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA'],
    ['password assignment', 'DATABASE_URL=postgres://admin:S3cr3tPassw0rd@db:5432/app'],
  ])('detects %s', (_name, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0);
  });

  it.each([
    'AWS docs example AKIAIOSFODNN7EXAMPLE',
    'const token = process.env.GITHUB_TOKEN;',
    'password: z.string().min(8)',
    'postgres://user:${DB_PASSWORD}@localhost/app',
    'sk-ant-... (placeholder)',
  ])('ignores placeholders and references: %s', (text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it('reports the rule and a redacted preview, never the full secret', () => {
    const [hit] = findSecrets('AKIAZ3MSJV4WAX7KQ2PL');
    expect(hit).toEqual({ rule: 'aws-access-key', preview: 'AKIA…Q2PL' });
  });
});
