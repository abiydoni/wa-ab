import { NextResponse } from "next/server";
import { waManager } from "@/modules/whatsapp/manager";
import { syncGroups } from "@/modules/whatsapp/store/groups";
import { prisma } from "@/lib/prisma";
import type { WASocket } from "@whiskeysockets/baileys";

export async function GET() {
    try {
        const sessions = await prisma.session.findMany({ where: { status: "CONNECTED" } });
        const results = [];
        for (const s of sessions) {
            const instance = waManager.getInstance(s.sessionId);
            if (instance && instance.socket) {
                const rawGroupsObj = await (instance.socket as WASocket).groupFetchAllParticipating();
                await syncGroups(instance.socket as WASocket, s.sessionId);
                const count = await prisma.group.count({ where: { sessionId: s.id } });
                results.push({ sessionId: s.sessionId, groupCount: count, rawGroups: rawGroupsObj });
            } else {
                results.push({ sessionId: s.sessionId, error: "No active socket in waManager memory" });
            }
        }
        return NextResponse.json({ success: true, results });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message, stack: error.stack });
    }
}
