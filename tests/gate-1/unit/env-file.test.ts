import { describe, expect, it } from 'vitest';
import { parseEnvFile, readEnvFile } from '@ats/doctor';

describe('.env parsing', () => {
  it('reads plain assignments and ignores comments and blank lines', () => {
    expect(
      parseEnvFile(
        ['# a comment', '', 'AWS_REGION=us-east-1', '  AWS_ACCOUNT_ID=123456789012  '].join('\n'),
      ),
    ).toEqual({ AWS_REGION: 'us-east-1', AWS_ACCOUNT_ID: '123456789012' });
  });

  it('strips surrounding quotes but keeps the contents intact', () => {
    expect(parseEnvFile('WEB_QUEUE_PASSWORD="p@ss word#1"')).toEqual({
      WEB_QUEUE_PASSWORD: 'p@ss word#1',
    });
    expect(parseEnvFile("WEB_QUEUE_PASSWORD='single'")).toEqual({
      WEB_QUEUE_PASSWORD: 'single',
    });
  });

  it('keeps a # that is part of an unquoted value', () => {
    // Connection strings and generated passwords routinely contain '#'. Treating every '#'
    // as a comment would silently truncate a credential — the worst kind of config bug.
    expect(
      parseEnvFile('COCKROACH_DATABASE_URL=postgresql://u:pa#ss@host:26257/ats'),
    ).toEqual({ COCKROACH_DATABASE_URL: 'postgresql://u:pa#ss@host:26257/ats' });
  });

  it('strips a clearly separated trailing comment', () => {
    expect(parseEnvFile('LOG_LEVEL=debug   # noisy but useful')).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('keeps = inside a value', () => {
    expect(parseEnvFile('AGENTCORE_GATEWAY_AUTH_TOKEN=abc=def=')).toEqual({
      AGENTCORE_GATEWAY_AUTH_TOKEN: 'abc=def=',
    });
  });

  it('tolerates `export` prefixes and CRLF line endings', () => {
    expect(parseEnvFile('export AWS_REGION=eu-west-1\r\nLOG_LEVEL=warn\r\n')).toEqual({
      AWS_REGION: 'eu-west-1',
      LOG_LEVEL: 'warn',
    });
  });

  it('skips malformed lines rather than throwing', () => {
    expect(parseEnvFile('not-an-assignment\n=novalue\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });

  it('returns an empty record when the file does not exist', () => {
    // The doctor must run and report before .env has been created — that is precisely the
    // situation its config check exists to describe.
    expect(readEnvFile('this/path/does/not/exist/.env')).toEqual({});
  });
});
