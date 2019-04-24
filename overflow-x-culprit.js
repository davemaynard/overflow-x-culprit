var parents = [];

var getParentNode = function(node) {
	const parent = node.parentNode;
	if (parent) {
		parents.push(parent);
		getParentNode(parent);
	}
}

document.querySelectorAll('*').forEach(function(node) {
	const rect = node.getBoundingClientRect(),
		right = rect.left + rect.width;
	if (right > window.innerWidth) {
		parents.length = 0;
		getParentNode(node);

		let isOverflowVisible = true;
		for (let i = 0; i < parents.length; i++) {
			const parent = parents[i];
			if (parent.localName) {
				const compStyles = window.getComputedStyle(parent),
					overflowX = compStyles.getPropertyValue('overflow-x'),
					position = compStyles.getPropertyValue('position');
				if (overflowX == 'hidden' || position == 'fixed') {
					isOverflowVisible = false;
					break;
				}
			}
		}

		if (isOverflowVisible) {
			console.log(node);
		}
	}
});