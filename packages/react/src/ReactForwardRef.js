/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {REACT_FORWARD_REF_TYPE, REACT_MEMO_TYPE} from 'shared/ReactSymbols';
// React.forwardRef 会创建一个React组件，这个组件能够将其接受的 ref 属性转发到其组件树下的另一个组件中。这种技术并不常见，但在以下两种场景中特别有用：
export function forwardRef<Props, ElementType: React$ElementType>(
  render: (props: Props, ref: React$Ref<ElementType>) => React$Node,
) {
  const elementType = {
    $$typeof: REACT_FORWARD_REF_TYPE,
    render,
  };
  return elementType;
}
