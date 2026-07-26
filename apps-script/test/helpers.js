'use strict';

/**
 * Test helpers for loading the project's plain-global .js files (the
 * clasp-style layout Apps Script expects, with no import/export) into a
 * Node vm context, optionally with mocked Apps Script globals injected.
 *
 * Logic.js has zero Apps Script dependencies, so it can be loaded on its
 * own. Code.js references SpreadsheetApp/PropertiesService/UrlFetchApp/
 * ContentService, so tests that load it must supply mocks for those.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Execute the named project files (in order) inside a single shared vm
 * context, seeded with `extraGlobals`. Because Apps Script files declare
 * plain top-level functions/vars (no module system), each becomes a
 * property on the returned context object.
 */
function loadGasContext(filenames, extraGlobals) {
  const context = Object.assign({}, extraGlobals || {});
  vm.createContext(context);
  filenames.forEach((filename) => {
    const filePath = path.join(PROJECT_ROOT, filename);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, context, { filename });
  });
  return context;
}

// ---------------------------------------------------------------------------
// Apps Script global mocks
// ---------------------------------------------------------------------------

/**
 * An in-memory stand-in for a Sheet, backed by a 2D array (row 1 = header).
 * Supports just the Range surface Code.js actually uses:
 * getDataRange().getValues(), getLastColumn(), and
 * getRange(row, col[, numRows, numCols]).getValues()/getValue()/setValue().
 */
function createMockSheet(initialValues, options) {
  const data = initialValues.map((row) => row.slice());
  // Simulates a Sheets data-validation rule (e.g. a "Yes"/"No" dropdown)
  // that rejects boolean writes to specific 1-indexed columns, matching
  // what a real validated cell does when you setValue() the wrong type.
  const rejectBooleanColumns = (options && options.rejectBooleanColumns) || [];

  function getRange(row, col, numRows, numCols) {
    const rows = numRows === undefined ? 1 : numRows;
    const cols = numCols === undefined ? 1 : numCols;
    return {
      getValues() {
        const result = [];
        for (let r = 0; r < rows; r++) {
          const rowArr = [];
          for (let c = 0; c < cols; c++) {
            const rowData = data[row - 1 + r] || [];
            rowArr.push(rowData[col - 1 + c] === undefined ? '' : rowData[col - 1 + c]);
          }
          result.push(rowArr);
        }
        return result;
      },
      getValue() {
        const rowData = data[row - 1] || [];
        const v = rowData[col - 1];
        return v === undefined ? '' : v;
      },
      setValue(value) {
        if (typeof value === 'boolean' && rejectBooleanColumns.indexOf(col) !== -1) {
          throw new Error(
            'Exception: The data you entered in cell violates the data validation ' +
            'rules set on this cell. Please enter one of the following values: Yes, No.'
          );
        }
        while (data.length < row) data.push([]);
        while (data[row - 1].length < col) data[row - 1].push('');
        data[row - 1][col - 1] = value;
      }
    };
  }

  return {
    getDataRange() {
      const lastRow = data.length;
      const lastCol = data.reduce((max, row) => Math.max(max, row.length), 0);
      return getRange(1, 1, lastRow, lastCol);
    },
    getLastColumn() {
      return data.length > 0 ? data[0].length : 0;
    },
    getRange,
    _snapshot() {
      return data.map((row) => row.slice());
    }
  };
}

function createMockPropertiesService(props) {
  return {
    getScriptProperties() {
      return {
        getProperty(key) {
          return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null;
        }
      };
    }
  };
}

function createMockSpreadsheetApp(sheet) {
  const flushCalls = { count: 0 };
  return {
    openById(_id) {
      return {
        getSheets() {
          return [sheet];
        }
      };
    },
    flush() {
      // No-op effect (the mock sheet's setValue() is already synchronous,
      // unlike real Apps Script which can batch/defer writes) -- but call
      // count is tracked so tests can assert Code.js still calls this after
      // writing the Watched cell. Skipping it is exactly what let a write
      // failure surface later as an unrelated-looking read exception in
      // production instead of being catchable at the write site.
      flushCalls.count++;
    },
    _flushCalls: flushCalls
  };
}

/**
 * `responseForUrl` is a function(url) => parsed JSON object to hand back
 * from UrlFetchApp.fetch. Every call is recorded in `.calls` for assertions
 * about whether/how many times TMDB was hit.
 */
function createMockUrlFetchApp(responseForUrl) {
  const calls = [];
  return {
    calls,
    fetch(url, options) {
      calls.push({ url, options });
      const json = responseForUrl(url);
      return {
        getContentText() {
          return JSON.stringify(json);
        }
      };
    }
  };
}

const mockContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput(text) {
    return {
      _text: text,
      _mimeType: null,
      setMimeType(mt) {
        this._mimeType = mt;
        return this;
      },
      json() {
        return JSON.parse(this._text);
      }
    };
  }
};

module.exports = {
  loadGasContext,
  createMockSheet,
  createMockPropertiesService,
  createMockSpreadsheetApp,
  createMockUrlFetchApp,
  mockContentService
};
