import { EMPTY_OBJ, EMPTY_ARR } from '../constants';
import { Component, enqueueRender } from '../component';
import { coerceToVNode, Fragment } from '../create-element';
import { diffChildren, toChildArray } from './children';
import { diffProps } from './props';
import { assign, removeNode } from '../util';
import options from '../options';

/**
 * Diff two virtual nodes and apply proper changes to the DOM
 * @param {import('../internal').PreactElement} parentDom The parent of the DOM element
 * @param {import('../internal').VNode | null} newVNode The new virtual node
 * @param {import('../internal').VNode | null} oldVNode The old virtual node
 * @param {object} context The current context object
 * @param {boolean} isSvg Whether or not this element is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} mounts A list of newly
 * mounted components
 * @param {Element | Text} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 */
export function diff(parentDom, newVNode, oldVNode, context, isSvg, excessDomChildren, mounts, force, oldDom) {
	let c, tmp, isNew, oldProps, oldState, snapshot,
		newType = newVNode.type, clearProcessingException;

	// When passing through createElement it assigns the object
	// constructor as undefined. This to prevent JSON-injection.
	if (newVNode.constructor !== undefined) return null;

	if (tmp = options._diff) tmp(newVNode);

	try {
		outer: if (typeof newType==='function') {

			// Necessary for createContext api. Setting this property will pass
			// the context value as `this.context` just for this component.
			tmp = newType.contextType;
			let provider = tmp && context[tmp._id];
			let cctx = tmp ? (provider ? provider.props.value : tmp._defaultValue) : context;

			// Get component and set it to `c`
			if (oldVNode._component) {
				c = newVNode._component = oldVNode._component;
				clearProcessingException = c._processingException = c._pendingError;
			}
			else {
				// Instantiate the new component
				if (newType.prototype && newType.prototype.render) {
					newVNode._component = c = new newType(newVNode.props, cctx); // eslint-disable-line new-cap
				}
				else {
					newVNode._component = c = new Component(newVNode.props, cctx);
					c.constructor = newType;
					c.render = doRender;
				}
				if (provider) provider.sub(c);

				c.props = newVNode.props;
				if (!c.state) c.state = {};
				c.context = cctx;
				c._context = context;
				isNew = c._dirty = true;
				c._renderCallbacks = [];
			}

			// Invoke getDerivedStateFromProps
			if (c._nextState==null) {
				c._nextState = c.state;
			}
			if (newType.getDerivedStateFromProps!=null) {
				assign(c._nextState==c.state ? (c._nextState = assign({}, c._nextState)) : c._nextState, newType.getDerivedStateFromProps(newVNode.props, c._nextState));
			}

			// Invoke pre-render lifecycle methods
			if (isNew) {
				if (newType.getDerivedStateFromProps==null && c.componentWillMount!=null) c.componentWillMount();
				if (c.componentDidMount!=null) mounts.push(c);
			}
			else {
				if (newType.getDerivedStateFromProps==null && force==null && c.componentWillReceiveProps!=null) {
					c.componentWillReceiveProps(newVNode.props, cctx);
				}

				if (!force && c.shouldComponentUpdate!=null && c.shouldComponentUpdate(newVNode.props, c._nextState, cctx)===false) {
					c.props = newVNode.props;
					c.state = c._nextState;
					c._dirty = false;
					c._vnode = newVNode;
					newVNode._dom = oldVNode._dom;
					newVNode._children = oldVNode._children;
					break outer;
				}

				if (c.componentWillUpdate!=null) {
					c.componentWillUpdate(newVNode.props, c._nextState, cctx);
				}
			}

			oldProps = c.props;
			oldState = c.state;

			c.context = cctx;
			c.props = newVNode.props;
			c.state = c._nextState;

			if (tmp = options._render) tmp(newVNode);

			c._dirty = false;

			try {
				tmp = c.render(c.props, c.state, c.context);
				let isTopLevelFragment = tmp != null && tmp.type == Fragment && tmp.key == null;
				toChildArray(isTopLevelFragment ? tmp.props.children : tmp, newVNode._children=[], coerceToVNode, true);
			}
			catch (e) {
				if ((tmp = options._catchRender) && tmp(e, newVNode, oldVNode)) break outer;
				throw e;
			}

			if (c.getChildContext!=null) {
				context = assign(assign({}, context), c.getChildContext());
			}

			if (!isNew && c.getSnapshotBeforeUpdate!=null) {
				snapshot = c.getSnapshotBeforeUpdate(oldProps, oldState);
			}

			diffChildren(parentDom, newVNode, oldVNode, context, isSvg, excessDomChildren, mounts, oldDom);

			// Only change the fields on the component once they represent the new state of the DOM
			c.base = newVNode._dom;
			c._vnode = newVNode;
			c._parentDom = parentDom;

			while (tmp=c._renderCallbacks.pop()) tmp.call(c);

			// Don't call componentDidUpdate on mount or when we bailed out via
			// `shouldComponentUpdate`
			if (!isNew && oldProps!=null && c.componentDidUpdate!=null) {
				c.componentDidUpdate(oldProps, oldState, snapshot);
			}
		}
		else {
			newVNode._dom = diffElementNodes(oldVNode._dom, newVNode, oldVNode, context, isSvg, excessDomChildren, mounts);
		}

		if (clearProcessingException) {
			c._pendingError = c._processingException = null;
		}

		if (tmp = options.diffed) tmp(newVNode);
	}
	catch (e) {
		catchErrorInComponent(e, newVNode._parent);
	}

	return newVNode._dom;
}

export function commitRoot(mounts, root) {
	let c;
	while ((c = mounts.pop())) {
		try {
			c.componentDidMount();
		}
		catch (e) {
			catchErrorInComponent(e, c._vnode._parent);
		}
	}

	if (options._commit) options._commit(root);
}

/**
 * Diff two virtual nodes representing DOM element
 * @param {import('../internal').PreactElement} dom The DOM element representing
 * the virtual nodes being diffed
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} context The current context object
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {*} excessDomChildren
 * @param {Array<import('../internal').Component>} mounts An array of newly
 * mounted components
 * @returns {import('../internal').PreactElement}
 */
function diffElementNodes(dom, newVNode, oldVNode, context, isSvg, excessDomChildren, mounts) {
	let i;
	let oldProps = oldVNode.props;
	let newProps = newVNode.props;

	// Tracks entering and exiting SVG namespace when descending through the tree.
	isSvg = newVNode.type==='svg' || isSvg;

	if (dom==null && excessDomChildren!=null) {
		for (i=0; i<excessDomChildren.length; i++) {
			const child = excessDomChildren[i];
			if (child!=null && (newVNode.type===null ? child.nodeType===3 : child.localName===newVNode.type)) {
				dom = child;
				excessDomChildren[i] = null;
				break;
			}
		}
	}

	if (dom==null) {
		if (newVNode.type===null) {
			return document.createTextNode(newProps);
		}
		dom = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', newVNode.type) : document.createElement(newVNode.type);
		// we created a new parent, so none of the previously attached children can be reused:
		excessDomChildren = null;
	}

	if (newVNode.type===null) {
		if (oldProps !== newProps) {
			dom.data = newProps;
		}
	}
	else {
		if (excessDomChildren!=null && dom.childNodes!=null) {
			excessDomChildren = EMPTY_ARR.slice.call(dom.childNodes);
		}
		if (newVNode!==oldVNode) {
			let oldProps = oldVNode.props || EMPTY_OBJ;
			let newProps = newVNode.props;

			let oldHtml = oldProps.dangerouslySetInnerHTML;
			let newHtml = newProps.dangerouslySetInnerHTML;
			if ((newHtml || oldHtml) && excessDomChildren==null) {
				// Avoid re-applying the same '__html' if it did not changed between re-render
				if (!newHtml || !oldHtml || newHtml.__html!=oldHtml.__html) {
					dom.innerHTML = newHtml && newHtml.__html || '';
				}
			}
			if (newProps.multiple) {
				dom.multiple = newProps.multiple;
			}

			diffChildren(dom, newVNode, oldVNode, context, newVNode.type==='foreignObject' ? false : isSvg, excessDomChildren, mounts, EMPTY_OBJ);
			diffProps(dom, newProps, oldProps, isSvg);
		}
	}

	return dom;
}

/**
 * Invoke or update a ref, depending on whether it is a function or object ref.
 * @param {object|function} ref
 * @param {any} value
 * @param {import('../internal').VNode} parentVNode
 */
export function applyRef(ref, value, parentVNode) {
	try {
		if (typeof ref=='function') ref(value);
		else ref.current = value;
	}
	catch (e) {
		catchErrorInComponent(e, parentVNode);
	}
}

/**
 * Unmount a virtual node from the tree and apply DOM changes
 * @param {import('../internal').VNode} vnode The virtual node to unmount
 * @param {import('../internal').VNode} parentVNode The parent of the VNode that
 * initiated the unmount
 * @param {boolean} [skipRemove] Flag that indicates that a parent node of the
 * current element is already detached from the DOM.
 */
export function unmount(vnode, parentVNode, skipRemove) {
	let r;
	if (options.unmount) options.unmount(vnode);

	if (r = vnode.ref) {
		applyRef(r, null, parentVNode);
	}

	let dom;
	if (!skipRemove && typeof vnode.type !== 'function') {
		skipRemove = (dom = vnode._dom)!=null;
	}

	vnode._dom = vnode._lastDomChild = null;

	if ((r = vnode._component)!=null) {
		if (r.componentWillUnmount) {
			try {
				r.componentWillUnmount();
			}
			catch (e) {
				catchErrorInComponent(e, parentVNode);
			}
		}

		r.base = r._parentDom = null;
	}

	if (r = vnode._children) {
		for (let i = 0; i < r.length; i++) {
			if (r[i]) unmount(r[i], parentVNode, skipRemove);
		}
	}

	if (dom!=null) removeNode(dom);
}

/** The `.render()` method for a PFC backing instance. */
function doRender(props, state, context) {
	return this.constructor(props, context);
}

/**
 * Find the closest error boundary to a thrown error and call it
 * @param {object} error The thrown value
 * @param {import('../internal').VNode} vnode The first ancestor
 * VNode check for error boundary behaviors
 */
function catchErrorInComponent(error, vnode) {
	if (options._catchError) { options._catchError(error, vnode); }

	/** @type {import('../internal').Component} */
	let component;

	for (; vnode; vnode = vnode._parent) {
		if ((component = vnode._component) && !component._processingException) {
			try {
				if (component.constructor && component.constructor.getDerivedStateFromError!=null) {
					component.setState(component.constructor.getDerivedStateFromError(error));
				}
				else if (component.componentDidCatch!=null) {
					component.componentDidCatch(error);
				}
				else {
					continue;
				}
				return enqueueRender(component._pendingError = component);
			}
			catch (e) {
				error = e;
			}
		}
	}

	throw error;
}
