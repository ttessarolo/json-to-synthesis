"use strict";

import * as fs from "fs";
import * as serialize from "serialize-javascript";
import get from "lodash.get";
import { gzipSync, unzipSync } from "zlib";
import Events from "events";

function checkStream(obj) {
  return obj != null && typeof obj.pipe === "function";
}

export default class Synthesizer extends Events {
  constructor({
    model,
    path,
    name = `model_${Date.now()}`,
    rules,
    skipKeys = [],
    defaultRuleMode = "top",
    defaultRuleValue = 3,
    defaultRuleOperator = "gte",
    keepAutogeneratedRules = false,
    verbose = false,

    filterData = () => false,
    translateKey = (k) => k,
    translateValue = (k, v) => v,
  }) {
    super();

    if (model) {
      this.extractDataFromModel(model);
      this.model = model;
    } else if (path) {
      this.loadModel(path);
    } else {
      this.rules = rules;
      this.skipKeys = skipKeys;
      this.defaultRuleMode = defaultRuleMode;
      this.defaultRuleValue = defaultRuleValue;
      this.defaultRuleOperator = defaultRuleOperator;
      this.keepAutogeneratedRules = keepAutogeneratedRules;
    }

    if (!this.name) this.name = name;
    if (!this.filterData) this.filterData = filterData;
    if (!this.translateKey) this.translateKey = translateKey;
    if (!this.translateValue) this.translateValue = translateValue;

    this.verbose = verbose;
  }

  setParams({ rules, skipFields, filterData, translateKey, translateValue }) {
    if (rules) this.rules = rules;
    if (skipFields) this.skipKeys = skipFields;
    if (filterData) this.filterData = filterData;
    if (translateKey) this.translateKey = translateKey;
    if (translateValue) this.translateValue;

    this.emit("model_update", this.getModel());
  }

  _buildDefaultRules(docs, dataPath) {
    const rulesSet = new Set();
    const rules = [];

    for (let doc of docs) {
      if (dataPath) doc = get(doc, dataPath);
      Object.keys(doc).forEach((k) => rulesSet.add(k));
    }

    rulesSet.forEach((key) => {
      if (!this.skipKeys.includes(key) && !this.filterData(key)) {
        rules.push({ key, threshold: this.defaultRuleValue, mode: this.defaultRuleMode });
      }
    });

    return rules;
  }

  getRules() {
    return this.rules;
  }

  async transform({ docs, rules, dataPath, includeStats = false, outputStream, cb }) {
    if (checkStream(docs) && (!rules || !this.rules)) {
      throw new Error("You Must Specify Rules when using a Stream");
    }

    const regole = (() => {
      if (rules) return rules;
      if (this.rules) return this.rules;

      const autoRules = this._buildDefaultRules(docs, dataPath);

      if (this.keepAutogeneratedRules) {
        this.rules = autoRules;
        this.emit("model_update", this.getModel());
      }

      return autoRules;
    })();

    if (!regole?.length > 0) {
      throw new Error("Not able to transform without rules");
    }

    if (outputStream && !checkStream(outputStream)) {
      throw new Error("outputStream must be a writable stream");
    }

    if (cb && !typeof cb === "function") {
      throw new Error("Callback must be a function");
    }

    const results = new Map();
    const fields = regole.map(({ key }) => key);
    fields.forEach((f) => results.set(f, { total: 0, values: {} }));

    const addValue = (value, root) => {
      if (!value) return;

      if (root.values[value]) root.values[value].count += 1;
      else root.values[value] = { count: 1 };

      root.total += 1;
    };

    for await (let doc of docs) {
      if (dataPath) doc = get(doc, dataPath);
      for (const key of fields) {
        if (!this.skipKeys.includes(key)) {
          const field = this.translateKey(key);
          const root = results.get(field);

          const value = get(doc, field);
          if (Array.isArray(value)) {
            value.forEach((v) => {
              if (!this.filterData(field, v)) {
                addValue(this.translateValue(field, v), root);
              }
            });
          } else {
            if (!this.filterData(field, value)) {
              addValue(this.translateValue(field, value), root);
            }
          }
        }
      }
    }

    // Compute Percentage
    results.forEach((v) => {
      const total = v.total;
      Object.entries(v.values).forEach(([key, value]) => {
        value.percentage = Number(((value.count / total) * 100).toFixed(1));
      });
    });

    // Sort Count
    const sortedResults = {};
    results.forEach((v, k) => {
      const sorted = Object.entries(v.values).sort((a, b) => {
        return b[1].count - a[1].count;
      });
      sortedResults[k] = sorted;
    });

    // Apply Rules
    const finalResults = {};
    const stats = {};

    Object.entries(sortedResults).forEach(([k, v]) => {
      const { threshold, mode, operator, cap } = regole.find((f) => f.key === k);

      if (mode === "top") {
        finalResults[k] = v.slice(0, threshold).map((k) => k[0]);
        if (includeStats) stats[k] = v.slice(0, threshold);
      } else if (mode === "percentage") {
        switch (operator) {
          case "equal": {
            finalResults[k] = v.filter((j) => j[1].percentage === threshold).map((i) => i[0]);
            if (includeStats) stats[k] = v.filter((j) => j[1].percentage === threshold);
          }
          case "lt": {
            finalResults[k] = v.filter((j) => j[1].percentage < threshold).map((i) => i[0]);
            if (includeStats) stats[k] = v.filter((j) => j[1].percentage < threshold);
          }
          case "lte": {
            finalResults[k] = v.filter((j) => j[1].percentage <= threshold).map((i) => i[0]);
            if (includeStats) stats[k] = v.filter((j) => j[1].percentage <= threshold);
          }
          case "gt": {
            finalResults[k] = v.filter((j) => j[1].percentage > threshold).map((i) => i[0]);
            if (includeStats) stats[k] = v.filter((j) => j[1].percentage > threshold);
          }
          default: {
            // gte
            finalResults[k] = v.filter((j) => j[1].percentage >= threshold).map((i) => i[0]);
            if (includeStats) stats[k] = v.filter((j) => j[1].percentage >= threshold);
          }
        }
        if (cap) {
          finalResults[k] = finalResults[k].slice(0, cap);
          if (includeStats) stats[k] = stats[k].slice(0, cap);
        }
      }
    });

    this.emit("transformed", { results: finalResults, chunk: docs, stats });

    if (outputStream) outputStream.write({ results: finalResults, chunk: docs, stats });
    if (cb) cb(null, finalResults, docs, stats);

    return includeStats ? [finalResults, stats] : finalResults;
  }

  extractDataFromModel(raw) {
    const decompressed = unzipSync(raw);
    const model = eval("(" + decompressed + ")");

    this.name = model.name;
    this.rules = model.rules;
    this.skipKeys = model.skipFields;
    this.filterData = model.filterData;
    this.translateKey = model.translateKey;
    this.translateValue = model.translateValue;
    this.defaultRuleMode = model.defaultRuleMode;
    this.defaultRuleValue = model.defaultRuleValue;
    this.defaultRuleOperator = model.defaultRuleOperator;
    this.keepAutogeneratedRules = model.keepAutogeneratedRules;

    return model;
  }

  getModel() {
    const model = {};
    model.name = this.name;
    model.rules = this.rules;
    model.skipKeys = this.skipKeys;
    model.filterData = this.filterData;
    model.translateKey = this.translateKey;
    model.translateValue = this.translateValue;
    model.defaultRuleMode = this.defaultRuleMode;
    model.defaultRuleValue = this.defaultRuleValue;
    model.defaultRuleOperator = this.defaultRuleOperator;
    model.keepAutogeneratedRules = this.keepAutogeneratedRules;
    model.creationDate = Date.now();

    const serialized = serialize.default(model);
    const compressed = gzipSync(Buffer.from(serialized));

    return [compressed, model];
  }

  saveModel({ dir, generateJSONCopy = false }) {
    if (!dir) throw new Error("No Path to Save Model");

    if (this.model) {
      const [compressed, model] = this.getModel();

      if (!dir.endsWith("/")) dir = `${dir}/`;
      if (generateJSONCopy) {
        fs.writeFileSync(`${dir}${model.name}.json`, JSON.stringify(model, null, 1));
      }

      fs.writeFileSync(`${dir}${model.name}.j2s`, compressed);

      this.emit("model_save", compressed, model);
      return [compressed, model];
    } else throw new Error("No Model To Save");
  }

  loadModel(path) {
    const raw = fs.readFileSync(path);
    const model = this.extractDataFromModel(raw);

    if (this.verbose) console.log(model);

    this.model = model;
    this.emit("model_loaded", model);
  }

  setModel(raw) {
    const model = this.extractDataFromModel(raw);

    if (this.verbose) console.log(model);

    this.model = model;
    this.emit("model_set", model);
  }
}
