(function () {
    function studentId() {
        let id = localStorage.getItem("hostelStudentId");
        if (!id) {
            id = window.crypto && typeof window.crypto.randomUUID === "function"
                ? window.crypto.randomUUID()
                : "student-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            localStorage.setItem("hostelStudentId", id);
        }
        return id;
    }

    async function request(url, options = {}) {
        const response = await fetch(url, {
            credentials: "same-origin",
            ...options,
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(options.headers || {})
            }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success === false) {
            throw new Error(result.message || `Request failed (${response.status}).`);
        }
        return result;
    }

    function showMessage(element, message, success = true) {
        if (!element) return;
        element.textContent = message;
        element.className = `notice ${success ? "success" : "error"}`;
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function backLink(destination, label) {
        const link = element("a", "button secondary", label);
        link.href = destination;
        return link;
    }

    window.hostelApp = { studentId, request, showMessage, element, backLink };
})();
