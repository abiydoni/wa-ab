import cron from "node-cron";
import { prisma } from "@/lib/prisma";
import { waManager } from "@/modules/whatsapp/manager";

export function initScheduler() {
    // Run every minute
    cron.schedule("* * * * *", async () => {
        try {
            const now = new Date();
            
            // Fetch pending messages due for sending
            const pendingMessages = await prisma.scheduledMessage.findMany({
                where: {
                    status: "PENDING",
                    sendAt: {
                        lte: now
                    }
                },
                include: {
                    session: true
                }
            });

            if (pendingMessages.length === 0) return;

            console.log(`Scheduler: Found ${pendingMessages.length} messages to send`);

            for (const msg of pendingMessages) {
                const instance = waManager.getInstance(msg.session.sessionId);

                if (!instance || !instance.socket) {
                    console.log(`Scheduler: Session ${msg.session.sessionId} not connected. Skipping.`);
                    // Optionally mark as FAILED or retry later
                    // keeping PENDING will define behavior (retry next minute)
                    // But if session is dead for long time, it piles up.
                    // Let's keep it PENDING for now.
                    continue;
                }

                try {
                    console.log(`Scheduler: Sending to ${msg.jid}`);
                    
                    if (msg.mediaUrl) {
                        // TODO: Handle media sending
                        await instance.socket.sendMessage(msg.jid, { 
                            text: msg.content // Caption for now if mediaUrl exists but logic not fully impl
                            // image: { url: msg.mediaUrl }
                        });
                    } else {
                        await instance.socket.sendMessage(msg.jid, { text: msg.content });
                    }

                    // Update status
                    await prisma.scheduledMessage.update({
                        where: { id: msg.id },
                        data: { status: "SENT" }
                    });

                } catch (error) {
                    console.error(`Scheduler: Check failed for ${msg.id}`, error);
                    await prisma.scheduledMessage.update({
                        where: { id: msg.id },
                        data: { status: "FAILED" } // Failed to send
                    });
                }
            }

        } catch (error) {
            console.error("Scheduler error:", error);
        }
    });
    
    console.log("Scheduler initialized");
}
