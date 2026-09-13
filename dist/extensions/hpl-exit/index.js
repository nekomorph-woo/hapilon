export default function hplExit(pi) {
    pi.registerCommand("exit", {
        description: "Quit hapilon (alias of /quit)",
        handler: async (_args, ctx) => {
            ctx.shutdown();
        },
    });
    pi.on("input", (event, ctx) => {
        if (event.source !== "interactive" || event.text.trim() !== "exit") {
            return undefined;
        }
        ctx.shutdown();
        return { action: "handled" };
    });
}
