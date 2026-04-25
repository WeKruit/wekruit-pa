import { z } from "zod"

export const ChannelSchema = z.enum(["imessage", "sms", "rcs", "other"])
export type Channel = z.infer<typeof ChannelSchema>
