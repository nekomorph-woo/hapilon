export default function hplExit(pi) {
    pi.registerCommand("exit", {
        description: "Quit hapilon (alias of /quit)",
        handler: async (_args, ctx) => {
            ctx.shutdown();
        },
    });
}
