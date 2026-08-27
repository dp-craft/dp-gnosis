import { homedir } from 'node:os';

import { cacheHome, configHome, dataHome, expandUserPath, stateHome } from '../src/env.js';

const EMPTY: NodeJS.ProcessEnv = {};
const HOME = homedir();

describe('env — user directory resolution', () => {
  describe('linux defaults', () => {
    it('uses the XDG fallback tree suffixed with the app dir', () => {
      expect(configHome(EMPTY, 'linux')).toBe(`${HOME}/.config/dp-gnosis`);
      expect(dataHome(EMPTY, 'linux')).toBe(`${HOME}/.local/share/dp-gnosis`);
      expect(cacheHome(EMPTY, 'linux')).toBe(`${HOME}/.cache/dp-gnosis`);
      expect(stateHome(EMPTY, 'linux')).toBe(`${HOME}/.local/state/dp-gnosis`);
    });

    it('honours the XDG variables when they are set', () => {
      const env: NodeJS.ProcessEnv = {
        XDG_CONFIG_HOME: '/x/cfg',
        XDG_DATA_HOME: '/x/data',
        XDG_CACHE_HOME: '/x/cache',
        XDG_STATE_HOME: '/x/state',
      };
      expect(configHome(env, 'linux')).toBe('/x/cfg/dp-gnosis');
      expect(dataHome(env, 'linux')).toBe('/x/data/dp-gnosis');
      expect(cacheHome(env, 'linux')).toBe('/x/cache/dp-gnosis');
      expect(stateHome(env, 'linux')).toBe('/x/state/dp-gnosis');
    });

    it('treats an unknown platform as linux', () => {
      expect(configHome(EMPTY, 'freebsd')).toBe(`${HOME}/.config/dp-gnosis`);
      expect(stateHome(EMPTY, 'freebsd')).toBe(`${HOME}/.local/state/dp-gnosis`);
    });
  });

  describe('darwin defaults', () => {
    it('uses the Apple convention for all four', () => {
      expect(configHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Application Support/dp-gnosis`);
      expect(dataHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Application Support/dp-gnosis`);
      expect(cacheHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Caches/dp-gnosis`);
      expect(stateHome(EMPTY, 'darwin')).toBe(`${HOME}/Library/Logs/dp-gnosis`);
    });

    it('lets a set XDG variable win over the Apple default', () => {
      const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: '/opt/xdg-data' };
      expect(dataHome(env, 'darwin')).toBe('/opt/xdg-data/dp-gnosis');
      expect(cacheHome(env, 'darwin')).toBe(`${HOME}/Library/Caches/dp-gnosis`);
    });
  });

  describe('win32 defaults', () => {
    it('falls back to the AppData tree when the variables are unset', () => {
      expect(configHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Roaming/dp-gnosis`);
      expect(dataHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Roaming/dp-gnosis`);
      expect(cacheHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Local/dp-gnosis`);
      expect(stateHome(EMPTY, 'win32')).toBe(`${HOME}/AppData/Local/dp-gnosis`);
    });

    it('reads APPDATA for config/data and LOCALAPPDATA for cache/state', () => {
      const env: NodeJS.ProcessEnv = { APPDATA: '/r', LOCALAPPDATA: '/l' };
      expect(configHome(env, 'win32')).toBe('/r/dp-gnosis');
      expect(dataHome(env, 'win32')).toBe('/r/dp-gnosis');
      expect(cacheHome(env, 'win32')).toBe('/l/dp-gnosis');
      expect(stateHome(env, 'win32')).toBe('/l/dp-gnosis');
    });
  });

  describe('gnosis-specific overrides', () => {
    it('outranks both the XDG variable and the platform default', () => {
      const env: NodeJS.ProcessEnv = {
        DP_GNOSIS_CONFIG_HOME: '/g/cfg',
        DP_GNOSIS_DATA_HOME: '/g/data',
        DP_GNOSIS_CACHE_HOME: '/g/cache',
        DP_GNOSIS_STATE_HOME: '/g/state',
        XDG_CONFIG_HOME: '/x/cfg',
        XDG_DATA_HOME: '/x/data',
        XDG_CACHE_HOME: '/x/cache',
        XDG_STATE_HOME: '/x/state',
        APPDATA: '/r',
        LOCALAPPDATA: '/l',
      };
      expect(configHome(env, 'linux')).toBe('/g/cfg/dp-gnosis');
      expect(dataHome(env, 'darwin')).toBe('/g/data/dp-gnosis');
      expect(cacheHome(env, 'win32')).toBe('/g/cache/dp-gnosis');
      expect(stateHome(env, 'linux')).toBe('/g/state/dp-gnosis');
    });
  });

  describe('empty and whitespace values are unset, never ""', () => {
    it('ignores an empty XDG variable instead of resolving to /dp-gnosis', () => {
      expect(dataHome({ XDG_DATA_HOME: '' }, 'linux')).toBe(`${HOME}/.local/share/dp-gnosis`);
      expect(cacheHome({ XDG_CACHE_HOME: '   ' }, 'linux')).toBe(`${HOME}/.cache/dp-gnosis`);
    });

    it('ignores an empty gnosis override and falls through to the platform default', () => {
      const env: NodeJS.ProcessEnv = { DP_GNOSIS_CONFIG_HOME: '  ', XDG_CONFIG_HOME: '/x/cfg' };
      expect(configHome(env, 'linux')).toBe('/x/cfg/dp-gnosis');
    });

    it('ignores an empty APPDATA', () => {
      expect(configHome({ APPDATA: '' }, 'win32')).toBe(`${HOME}/AppData/Roaming/dp-gnosis`);
    });
  });

  describe('a relative path is refused, by name', () => {
    it('throws naming the XDG variable and its value', () => {
      expect(() => dataHome({ XDG_DATA_HOME: 'relative/data' }, 'linux')).toThrow(
        /XDG_DATA_HOME.*relative\/data/
      );
    });

    it('refuses a relative value on every platform-specific variable', () => {
      expect(() => configHome({ XDG_CONFIG_HOME: './cfg' }, 'darwin')).toThrow(/XDG_CONFIG_HOME/);
      expect(() => cacheHome({ LOCALAPPDATA: 'AppData/Local' }, 'win32')).toThrow(/LOCALAPPDATA/);
      expect(() => stateHome({ DP_GNOSIS_STATE_HOME: '../state' }, 'linux')).toThrow(
        /DP_GNOSIS_STATE_HOME/
      );
    });

    it('MUST NOT resolve a relative value against cwd', () => {
      expect(() => dataHome({ XDG_DATA_HOME: 'relative/data' }, 'linux')).toThrow();
    });
  });

  describe('home expansion', () => {
    it('anchors every default on the real home directory', () => {
      const defaults = [
        configHome(EMPTY, 'linux'),
        dataHome(EMPTY, 'darwin'),
        cacheHome(EMPTY, 'win32'),
        stateHome(EMPTY, 'linux'),
      ];
      expect(defaults.every(p => p.startsWith(`${HOME}/`))).toBe(true);
      expect(defaults.some(p => p.startsWith('~'))).toBe(false);
    });
  });

  describe('expandUserPath', () => {
    it('expands a leading ~/ to the real home directory', () => {
      expect(expandUserPath('~/knowledge/standards')).toBe(`${HOME}/knowledge/standards`);
    });

    it('expands a bare ~ to the home directory itself', () => {
      expect(expandUserPath('~')).toBe(HOME);
    });

    it('leaves an absolute path and a relative path untouched', () => {
      expect(expandUserPath('/srv/docs')).toBe('/srv/docs');
      expect(expandUserPath('doc')).toBe('doc');
      expect(expandUserPath('claude-artifacts/standards')).toBe('claude-artifacts/standards');
    });

    it('MUST NOT expand a ~ that is not the first character', () => {
      expect(expandUserPath('doc/~backup')).toBe('doc/~backup');
    });

    it('REFUSES ~user/ by name rather than guessing another user home', () => {
      expect(() => expandUserPath('~alice/docs')).toThrow(/~alice\/docs/);
    });
  });

  describe('purity', () => {
    it('re-reads the environment on every call rather than freezing it at import', () => {
      expect(dataHome({ DP_GNOSIS_DATA_HOME: '/first' }, 'linux')).toBe('/first/dp-gnosis');
      expect(dataHome({ DP_GNOSIS_DATA_HOME: '/second' }, 'linux')).toBe('/second/dp-gnosis');
    });
  });
});
