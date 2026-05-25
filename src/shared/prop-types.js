"use client";

const chainable = new Proxy(function noop() {}, {
  apply() {
    return chainable;
  },
  get() {
    return chainable;
  }
});

const PropTypes = new Proxy(
  {},
  {
    get() {
      return chainable;
    }
  }
);

export default PropTypes;
