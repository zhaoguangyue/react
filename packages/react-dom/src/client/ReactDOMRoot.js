/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Container} from './ReactDOMHostConfig';
import type {RootTag} from 'react-reconciler/src/ReactRootTags';
import type {MutableSource, ReactNodeList} from 'shared/ReactTypes';
import type {FiberRoot} from 'react-reconciler/src/ReactInternalTypes';

export type RootType = {
  render(children: ReactNodeList): void,
  unmount(): void,
  _internalRoot: FiberRoot,
  ...
};

export type RootOptions = {
  hydrate?: boolean,
  hydrationOptions?: {
    onHydrated?: (suspenseNode: Comment) => void,
    onDeleted?: (suspenseNode: Comment) => void,
    mutableSources?: Array<MutableSource<any>>,
    ...
  },
  ...
};

import {
  isContainerMarkedAsRoot,
  markContainerAsRoot,
  unmarkContainerAsRoot,
} from './ReactDOMComponentTree';
import {eagerlyTrapReplayableEvents} from '../events/ReactDOMEventReplaying';
import {
  ELEMENT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
} from '../shared/HTMLNodeType';
import {ensureListeningTo} from './ReactDOMComponent';

import {
  createContainer,
  updateContainer,
  findHostInstanceWithNoPortals,
  registerMutableSourceForHydration,
} from 'react-reconciler/src/ReactFiberReconciler';
import invariant from 'shared/invariant';
import {
  BlockingRoot,
  ConcurrentRoot,
  LegacyRoot,
} from 'react-reconciler/src/ReactRootTags';

import {enableModernEventSystem} from 'shared/ReactFeatureFlags';

function ReactDOMRoot(container: Container, options: void | RootOptions) {
  this._internalRoot = createRootImpl(container, ConcurrentRoot, options);
}

function ReactDOMBlockingRoot(
  container: Container,
  tag: RootTag,
  options: void | RootOptions,
) {
  this._internalRoot = createRootImpl(container, tag, options);
}

ReactDOMRoot.prototype.render = ReactDOMBlockingRoot.prototype.render = function(
  children: ReactNodeList,
): void {
  const root = this._internalRoot;
  updateContainer(children, root, null, null);
};

ReactDOMRoot.prototype.unmount = ReactDOMBlockingRoot.prototype.unmount = function(): void {
  if (__DEV__) {
    if (typeof arguments[0] === 'function') {
      console.error(
        'unmount(...): does not support a callback argument. ' +
          'To execute a side effect after rendering, declare it in a component body with useEffect().',
      );
    }
  }
  const root = this._internalRoot;
  const container = root.containerInfo;
  updateContainer(null, root, null, () => {
    unmarkContainerAsRoot(container);
  });
};

function createRootImpl(
  container: Container,
  tag: RootTag,
  options: void | RootOptions,
) {
  // Tag is either LegacyRoot or Concurrent Root
  const hydrate = options != null && options.hydrate === true;
  const hydrationCallbacks =
    (options != null && options.hydrationOptions) || null;
  const mutableSources =
    (options != null &&
      options.hydrationOptions != null &&
      options.hydrationOptions.mutableSources) ||
    null;
  const root = createContainer(container, tag, hydrate, hydrationCallbacks);
  markContainerAsRoot(root.current, container);
  const containerNodeType = container.nodeType;

  if (hydrate && tag !== LegacyRoot) {
    const doc =
      containerNodeType === DOCUMENT_NODE ? container : container.ownerDocument;
    // We need to cast this because Flow doesn't work
    // with the hoisted containerNodeType. If we inline
    // it, then Flow doesn't complain. We intentionally
    // hoist it to reduce code-size.
    eagerlyTrapReplayableEvents(container, ((doc: any): Document));
  } else if (
    enableModernEventSystem &&
    containerNodeType !== DOCUMENT_FRAGMENT_NODE &&
    containerNodeType !== DOCUMENT_NODE
  ) {
    ensureListeningTo(container, 'onMouseEnter');
  }

  if (mutableSources) {
    for (let i = 0; i < mutableSources.length; i++) {
      const mutableSource = mutableSources[i];
      registerMutableSourceForHydration(root, mutableSource);
    }
  }

  return root;
}

export function createRoot(
  container: Container,
  options?: RootOptions,
): RootType {
  invariant(
    isValidContainer(container),
    'createRoot(...): Target container is not a DOM element.',
  );
  warnIfReactDOMContainerInDEV(container);
  return new ReactDOMRoot(container, options);
}

export function createBlockingRoot(
  container: Container,
  options?: RootOptions,
): RootType {
  invariant(
    isValidContainer(container),
    'createRoot(...): Target container is not a DOM element.',
  );
  warnIfReactDOMContainerInDEV(container);
  return new ReactDOMBlockingRoot(container, BlockingRoot, options);
}

export function createLegacyRoot(
  container: Container,
  options?: RootOptions,
): RootType {
  return new ReactDOMBlockingRoot(container, LegacyRoot, options);
}

export function isValidContainer(node: mixed): boolean {
  return !!(
    node &&
    (node.nodeType === ELEMENT_NODE ||
      node.nodeType === DOCUMENT_NODE ||
      node.nodeType === DOCUMENT_FRAGMENT_NODE ||
      (node.nodeType === COMMENT_NODE &&
        (node: any).nodeValue === ' react-mount-point-unstable '))
  );
}