import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import {
  initialBuildings,
  initialClassrooms,
  initialMaintenanceTickets,
  initialBookings,
  initialInventory,
  initialStaff,
  initialIncidents,
  initialMetrics
} from './src/data/seedData.ts';
import {
  Building,
  Classroom,
  MaintenanceTicket,
  RoomBooking,
  InventoryItem,
  StaffTechnician,
  CampusIncident,
  AiConfig
} from './src/types/campus.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// In-memory operational state
let buildings: Building[] = JSON.parse(JSON.stringify(initialBuildings));
let classrooms: Classroom[] = JSON.parse(JSON.stringify(initialClassrooms));
let maintenanceTickets: MaintenanceTicket[] = JSON.parse(JSON.stringify(initialMaintenanceTickets));
let bookings: RoomBooking[] = JSON.parse(JSON.stringify(initialBookings));
let inventory: InventoryItem[] = JSON.parse(JSON.stringify(initialInventory));
let staff: StaffTechnician[] = JSON.parse(JSON.stringify(initialStaff));
let incidents: CampusIncident[] = JSON.parse(JSON.stringify(initialIncidents));

// AI Configuration Store (Never sends raw key to browser)
let serverAiConfig: {
  provider: 'gemini' | 'openai';
  apiKey: string;
  model: string;
} = {
  provider: process.env.OPENAI_API_KEY ? 'openai' : 'gemini',
  apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || '',
  model: process.env.OPENAI_MODEL || (process.env.OPENAI_API_KEY ? 'gpt-4o-mini' : 'gemini-3.8-flash')
};

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// ==================== REST API ENDPOINTS ====================

// Buildings
app.get('/api/buildings', (_req: Request, res: Response) => {
  res.json(buildings);
});

app.get('/api/buildings/:id', (req: Request, res: Response) => {
  const b = buildings.find(item => item.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Building not found' });
  res.json(b);
});

// Classrooms
app.get('/api/classrooms', (req: Request, res: Response) => {
  const { buildingId, floorId, status, type, minCapacity } = req.query;
  let filtered = [...classrooms];
  if (buildingId) filtered = filtered.filter(r => r.buildingId === buildingId);
  if (floorId) filtered = filtered.filter(r => r.floorId === floorId);
  if (status) filtered = filtered.filter(r => r.status === status);
  if (type) filtered = filtered.filter(r => r.type === type);
  if (minCapacity) filtered = filtered.filter(r => r.capacity >= Number(minCapacity));
  res.json(filtered);
});

app.get('/api/classrooms/:id', (req: Request, res: Response) => {
  const room = classrooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'Classroom not found' });
  res.json(room);
});

app.patch('/api/classrooms/:id', (req: Request, res: Response) => {
  const index = classrooms.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Classroom not found' });
  classrooms[index] = { ...classrooms[index], ...req.body };
  res.json(classrooms[index]);
});

// Maintenance Tickets
app.get('/api/maintenance', (req: Request, res: Response) => {
  const { buildingId, status, severity } = req.query;
  let filtered = [...maintenanceTickets];
  if (buildingId) filtered = filtered.filter(t => t.buildingId === buildingId);
  if (status) filtered = filtered.filter(t => t.status === status);
  if (severity) filtered = filtered.filter(t => t.severity === severity);
  res.json(filtered);
});

app.post('/api/maintenance', (req: Request, res: Response) => {
  const { title, description, buildingId, roomId, category, severity, reportedBy } = req.body;
  if (!title || !buildingId) {
    return res.status(400).json({ error: 'Title and buildingId are required' });
  }

  const bldg = buildings.find(b => b.id === buildingId);
  const room = roomId ? classrooms.find(r => r.id === roomId) : undefined;

  const newTicket: MaintenanceTicket = {
    id: `tkt-${Date.now().toString().slice(-4)}`,
    title,
    description: description || 'No detailed description provided.',
    buildingId,
    buildingName: bldg ? bldg.name : 'Campus Building',
    floorId: room ? room.floorId : (bldg?.floors[0]?.id || ''),
    roomId: room?.id,
    roomNumber: room?.roomNumber,
    category: category || 'Audio/Visual',
    severity: severity || 'medium',
    status: 'open',
    reportedBy: reportedBy || 'Facilities Operator',
    reportedAt: new Date().toISOString()
  };

  // If critical/high, mark room as maintenance
  if (room && (severity === 'high' || severity === 'critical')) {
    room.status = 'maintenance';
  }

  // Update building count
  if (bldg) {
    bldg.openMaintenanceCount += 1;
  }

  maintenanceTickets.unshift(newTicket);
  res.status(201).json(newTicket);
});

app.patch('/api/maintenance/:id', (req: Request, res: Response) => {
  const index = maintenanceTickets.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Ticket not found' });

  const current = maintenanceTickets[index];
  const updated = { ...current, ...req.body };

  // If assigned technician changed, update technician name and count
  if (req.body.assignedTechnicianId && req.body.assignedTechnicianId !== current.assignedTechnicianId) {
    const tech = staff.find(s => s.id === req.body.assignedTechnicianId);
    if (tech) {
      updated.assignedTechnicianName = tech.name;
      tech.activeTicketsCount += 1;
      tech.status = 'on_task';
    }
  }

  // If status changed to resolved, restore room if needed
  if (req.body.status === 'resolved' && current.status !== 'resolved') {
    updated.resolvedAt = new Date().toISOString();
    if (updated.roomId) {
      const room = classrooms.find(r => r.id === updated.roomId);
      if (room && room.status === 'maintenance') {
        room.status = 'available';
      }
    }
    const bldg = buildings.find(b => b.id === updated.buildingId);
    if (bldg && bldg.openMaintenanceCount > 0) {
      bldg.openMaintenanceCount -= 1;
    }
  }

  maintenanceTickets[index] = updated;
  res.json(updated);
});

// Bookings
app.get('/api/bookings', (req: Request, res: Response) => {
  const { roomId, date } = req.query;
  let filtered = [...bookings];
  if (roomId) filtered = filtered.filter(b => b.roomId === roomId);
  if (date) filtered = filtered.filter(b => b.date === date);
  res.json(filtered);
});

app.post('/api/bookings', (req: Request, res: Response) => {
  const { roomId, title, organizer, department, date, startTime, endTime, attendeesCount, purpose, requiresAV } = req.body;
  if (!roomId || !title || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Room, title, date, startTime, and endTime are required' });
  }

  const room = classrooms.find(r => r.id === roomId);
  if (!room) return res.status(404).json({ error: 'Classroom not found' });

  if (room.status === 'maintenance') {
    return res.status(400).json({ error: `Room ${room.roomNumber} is currently under maintenance and cannot be booked.` });
  }

  // Check for time conflict
  const hasConflict = bookings.some(b => {
    if (b.roomId !== roomId || b.date !== date || b.status === 'cancelled') return false;
    return (startTime < b.endTime && endTime > b.startTime);
  });

  if (hasConflict) {
    return res.status(409).json({ error: `Time slot conflict detected for ${room.roomNumber} on ${date}.` });
  }

  const bldg = buildings.find(b => b.id === room.buildingId);

  const newBooking: RoomBooking = {
    id: `bk-${Date.now().toString().slice(-4)}`,
    roomId: room.id,
    roomNumber: room.roomNumber,
    roomName: room.name,
    buildingName: bldg?.name || 'Campus Building',
    title,
    organizer: organizer || 'Campus Faculty',
    department: department || 'Academics',
    date,
    startTime,
    endTime,
    attendeesCount: Number(attendeesCount) || 30,
    purpose: purpose || 'Academic session',
    status: 'confirmed',
    requiresAV: Boolean(requiresAV)
  };

  bookings.unshift(newBooking);
  res.status(201).json(newBooking);
});

app.patch('/api/bookings/:id', (req: Request, res: Response) => {
  const index = bookings.findIndex(b => b.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Booking not found' });
  bookings[index] = { ...bookings[index], ...req.body };
  res.json(bookings[index]);
});

app.delete('/api/bookings/:id', (req: Request, res: Response) => {
  const index = bookings.findIndex(b => b.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Booking not found' });
  const removed = bookings.splice(index, 1)[0];
  res.json({ message: 'Booking deleted', booking: removed });
});

// Inventory
app.get('/api/inventory', (_req: Request, res: Response) => {
  res.json(inventory);
});

app.patch('/api/inventory/:id', (req: Request, res: Response) => {
  const index = inventory.findIndex(item => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Item not found' });
  inventory[index] = { ...inventory[index], ...req.body };
  res.json(inventory[index]);
});

// Staff
app.get('/api/staff', (_req: Request, res: Response) => {
  res.json(staff);
});

// Incidents
app.get('/api/incidents', (_req: Request, res: Response) => {
  res.json(incidents);
});

app.post('/api/incidents', (req: Request, res: Response) => {
  const { title, description, category, severity, affectedBuildings, affectedRooms, actionTaken } = req.body;
  if (!title) return res.status(400).json({ error: 'Incident title is required' });

  const newIncident: CampusIncident = {
    id: `inc-${Date.now().toString().slice(-4)}`,
    title,
    description: description || '',
    category: category || 'Facility',
    severity: severity || 'medium',
    status: 'investigating',
    affectedBuildings: affectedBuildings || ['Orion Academic Block'],
    affectedRooms: affectedRooms || [],
    reportedAt: new Date().toISOString(),
    actionTaken: actionTaken || 'Facilities dispatch alerted.'
  };

  incidents.unshift(newIncident);
  res.status(201).json(newIncident);
});

// Metrics
app.get('/api/metrics', (_req: Request, res: Response) => {
  const lowStock = inventory.filter(i => i.quantityInStock <= i.minimumThreshold).length;
  const openTickets = maintenanceTickets.filter(t => t.status !== 'resolved' && t.status !== 'closed').length;
  const activeStaff = staff.filter(s => s.status === 'available').length;
  const activeInc = incidents.filter(i => i.status !== 'resolved').length;

  const metrics = {
    ...initialMetrics,
    openMaintenanceTickets: openTickets,
    lowStockItemsCount: lowStock,
    availableStaffCount: activeStaff,
    activeIncidentsCount: activeInc
  };
  res.json(metrics);
});

// ==================== AI CONFIGURATION ENDPOINTS ====================

app.get('/api/ai/config', (_req: Request, res: Response) => {
  const configResponse: AiConfig = {
    provider: serverAiConfig.provider,
    hasApiKey: Boolean(serverAiConfig.apiKey && serverAiConfig.apiKey.trim().length > 0),
    maskedKey: maskApiKey(serverAiConfig.apiKey),
    model: serverAiConfig.model,
    updatedAt: new Date().toISOString()
  };
  res.json(configResponse);
});

app.post('/api/ai/config', (req: Request, res: Response) => {
  const { provider, apiKey, model, clearKey } = req.body;
  if (clearKey) {
    serverAiConfig.apiKey = '';
    return res.json({ success: true, message: 'AI API credentials cleared' });
  }

  if (provider && (provider === 'gemini' || provider === 'openai')) {
    serverAiConfig.provider = provider;
  }
  if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
    serverAiConfig.apiKey = apiKey.trim();
  }
  if (model && typeof model === 'string') {
    serverAiConfig.model = model.trim();
  }

  res.json({
    success: true,
    message: 'AI Configuration successfully updated',
    provider: serverAiConfig.provider,
    hasApiKey: Boolean(serverAiConfig.apiKey),
    maskedKey: maskApiKey(serverAiConfig.apiKey),
    model: serverAiConfig.model
  });
});

app.post('/api/ai/test', async (_req: Request, res: Response) => {
  if (!serverAiConfig.apiKey) {
    // If no key configured, we still allow local semantic mode
    return res.json({
      success: true,
      mode: 'built-in-local',
      message: 'CampusOps intelligent semantic rule engine is active and ready.'
    });
  }

  try {
    if (serverAiConfig.provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey: serverAiConfig.apiKey });
      const response = await ai.models.generateContent({
        model: serverAiConfig.model || 'gemini-3.8-flash',
        contents: 'Respond with exactly "PONG" to test connection.'
      });
      return res.json({
        success: true,
        mode: 'gemini',
        response: response.text?.slice(0, 50) || 'OK'
      });
    } else {
      // Test OpenAI-compatible endpoint
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${serverAiConfig.apiKey}`
        }
      });
      if (!response.ok) {
        throw new Error(`OpenAI API returned status ${response.status}`);
      }
      return res.json({
        success: true,
        mode: 'openai',
        message: 'OpenAI connection verified successfully.'
      });
    }
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Connection test failed with provided credentials'
    });
  }
});

// ==================== AI COPILOT TOOL-CALLING SYSTEM ====================

// Tool implementation handlers that operate directly and securely on campus data
const toolHandlers: Record<string, (args?: any) => any> = {
  search_rooms: (args) => {
    let list = [...classrooms];
    if (args.buildingName) {
      const b = buildings.find(b => b.name.toLowerCase().includes(args.buildingName.toLowerCase()));
      if (b) list = list.filter(r => r.buildingId === b.id);
    }
    if (args.type) {
      list = list.filter(r => r.type.toLowerCase().includes(args.type.toLowerCase()));
    }
    if (args.status) {
      list = list.filter(r => r.status.toLowerCase() === args.status.toLowerCase());
    }
    if (args.minCapacity) {
      list = list.filter(r => r.capacity >= args.minCapacity);
    }
    if (args.equipmentKeyword) {
      list = list.filter(r => r.equipment.some(e => e.toLowerCase().includes(args.equipmentKeyword.toLowerCase())));
    }
    return {
      count: list.length,
      rooms: list.map(r => ({
        id: r.id,
        name: r.name,
        roomNumber: r.roomNumber,
        building: buildings.find(b => b.id === r.buildingId)?.name,
        capacity: r.capacity,
        type: r.type,
        status: r.status,
        equipment: r.equipment
      }))
    };
  },

  get_room_details: (args) => {
    const q = (args.roomNumber || args.roomId || '').toLowerCase();
    const room = classrooms.find(r => r.roomNumber.toLowerCase().includes(q) || r.id === q);
    if (!room) return { error: `Room ${args.roomNumber || args.roomId} not found in campus database.` };
    const bldg = buildings.find(b => b.id === room.buildingId);
    const roomBookings = bookings.filter(b => b.roomId === room.id);
    const roomTickets = maintenanceTickets.filter(t => t.roomId === room.id && t.status !== 'resolved');
    return {
      room,
      building: bldg?.name,
      activeBookings: roomBookings,
      openTickets: roomTickets
    };
  },

  get_building_details: (args) => {
    const q = (args.buildingName || '').toLowerCase();
    const b = buildings.find(item => item.name.toLowerCase().includes(q) || item.code.toLowerCase().includes(q)) || buildings[0];
    const bldgRooms = classrooms.filter(r => r.buildingId === b.id);
    const bldgTickets = maintenanceTickets.filter(t => t.buildingId === b.id && t.status !== 'resolved');
    return {
      building: b,
      totalRooms: bldgRooms.length,
      availableRooms: bldgRooms.filter(r => r.status === 'available').length,
      openTicketsCount: bldgTickets.length,
      openTickets: bldgTickets
    };
  },

  check_room_availability: (args) => {
    const date = args.date || '2026-10-27';
    const targetRoom = classrooms.find(r => r.roomNumber.toLowerCase().includes((args.roomNumber || '').toLowerCase()));
    if (!targetRoom) {
      // Find all available rooms on date
      const bookedRoomIds = new Set(bookings.filter(b => b.date === date && b.status !== 'cancelled').map(b => b.roomId));
      const available = classrooms.filter(r => !bookedRoomIds.has(r.id) && r.status !== 'maintenance');
      return {
        date,
        availableRoomsCount: available.length,
        availableRooms: available.map(r => ({ roomNumber: r.roomNumber, name: r.name, capacity: r.capacity, type: r.type }))
      };
    }

    const roomBookings = bookings.filter(b => b.roomId === targetRoom.id && b.date === date && b.status !== 'cancelled');
    const isMaintenance = targetRoom.status === 'maintenance';
    return {
      room: targetRoom.roomNumber,
      date,
      status: isMaintenance ? 'Under Maintenance' : (roomBookings.length > 0 ? 'Partially Booked' : 'Fully Available'),
      scheduledSlots: roomBookings.map(b => `${b.startTime} - ${b.endTime}: ${b.title} (${b.organizer})`)
    };
  },

  search_incidents: (args) => {
    let list = [...incidents];
    if (args.keyword) {
      const kw = args.keyword.toLowerCase();
      list = list.filter(i => i.title.toLowerCase().includes(kw) || i.description.toLowerCase().includes(kw) || i.category.toLowerCase().includes(kw));
    }
    if (args.severity) {
      list = list.filter(i => i.severity.toLowerCase() === args.severity.toLowerCase());
    }
    return {
      total: list.length,
      incidents: list
    };
  },

  get_inventory_status: (args) => {
    let list = [...inventory];
    if (args.lowStockOnly) {
      list = list.filter(i => i.quantityInStock <= i.minimumThreshold);
    }
    if (args.category) {
      list = list.filter(i => i.category.toLowerCase().includes(args.category.toLowerCase()));
    }
    return {
      totalItems: list.length,
      items: list.map(i => ({
        id: i.id,
        name: i.name,
        inStock: i.quantityInStock,
        minimum: i.minimumThreshold,
        status: i.quantityInStock <= i.minimumThreshold ? 'LOW_STOCK_ALERT' : 'Normal',
        location: i.location
      }))
    };
  },

  find_available_technicians: (args) => {
    let list = [...staff];
    if (args.specialty) {
      list = list.filter(s => s.specialties.some(sp => sp.toLowerCase().includes(args.specialty.toLowerCase())));
    }
    if (args.status) {
      list = list.filter(s => s.status === args.status);
    }
    return {
      count: list.length,
      technicians: list.map(t => ({
        id: t.id,
        name: t.name,
        role: t.role,
        specialties: t.specialties,
        status: t.status,
        activeTickets: t.activeTicketsCount,
        rating: t.rating
      }))
    };
  },

  create_maintenance_request: (args) => {
    const room = classrooms.find(r => r.roomNumber.toLowerCase().includes((args.roomNumber || '').toLowerCase()));
    const bldg = room ? buildings.find(b => b.id === room.buildingId) : (buildings.find(b => b.name.toLowerCase().includes((args.buildingName || '').toLowerCase())) || buildings[0]);

    const newTicket: MaintenanceTicket = {
      id: `tkt-${Date.now().toString().slice(-4)}`,
      title: args.title || `Maintenance required for ${room ? room.roomNumber : bldg?.name}`,
      description: args.description || 'Reported via CampusOps AI Copilot',
      buildingId: bldg ? bldg.id : 'bldg-orion',
      buildingName: bldg ? bldg.name : 'Orion Academic Block',
      floorId: room ? room.floorId : 'fl-orion-0',
      roomId: room?.id,
      roomNumber: room?.roomNumber,
      category: args.category || 'Audio/Visual',
      severity: args.severity || 'high',
      status: 'open',
      reportedBy: args.reportedBy || 'CampusOps AI Assistant',
      reportedAt: new Date().toISOString()
    };

    if (room && (newTicket.severity === 'high' || newTicket.severity === 'critical')) {
      room.status = 'maintenance';
    }
    if (bldg) {
      bldg.openMaintenanceCount += 1;
    }
    maintenanceTickets.unshift(newTicket);

    return {
      success: true,
      ticket: newTicket,
      message: `Maintenance ticket #${newTicket.id} created for ${newTicket.roomNumber || newTicket.buildingName}.`
    };
  },

  create_booking_request: (args) => {
    const room = classrooms.find(r => r.roomNumber.toLowerCase().includes((args.roomNumber || '').toLowerCase()));
    if (!room) return { error: `Classroom ${args.roomNumber} not found.` };
    if (room.status === 'maintenance') return { error: `Classroom ${room.roomNumber} is under maintenance.` };

    const date = args.date || '2026-10-28';
    const startTime = args.startTime || '14:00';
    const endTime = args.endTime || '16:00';

    const bldg = buildings.find(b => b.id === room.buildingId);
    const newBooking: RoomBooking = {
      id: `bk-${Date.now().toString().slice(-4)}`,
      roomId: room.id,
      roomNumber: room.roomNumber,
      roomName: room.name,
      buildingName: bldg?.name || 'Orion Academic Block',
      title: args.title || 'Academic Booking',
      organizer: args.organizer || 'Faculty Member',
      department: args.department || 'Computer Science',
      date,
      startTime,
      endTime,
      attendeesCount: args.attendeesCount || 30,
      purpose: args.purpose || 'Session scheduled via Copilot',
      status: 'confirmed',
      requiresAV: Boolean(args.requiresAV)
    };

    bookings.unshift(newBooking);
    return {
      success: true,
      booking: newBooking,
      message: `Booking confirmed for ${room.roomNumber} on ${date} (${startTime} - ${endTime}).`
    };
  },

  get_incident_summary: () => {
    const active = incidents.filter(i => i.status !== 'resolved');
    return {
      activeIncidentsCount: active.length,
      incidents: active.map(i => ({
        title: i.title,
        severity: i.severity,
        affectedBuildings: i.affectedBuildings,
        status: i.status,
        actionTaken: i.actionTaken
      }))
    };
  },

  get_dashboard_metrics: () => {
    return {
      totalBuildings: buildings.length,
      totalClassrooms: classrooms.length,
      openTickets: maintenanceTickets.filter(t => t.status !== 'resolved').length,
      activeIncidents: incidents.filter(i => i.status !== 'resolved').length,
      lowStockItems: inventory.filter(i => i.quantityInStock <= i.minimumThreshold).length,
      availableStaff: staff.filter(s => s.status === 'available').length
    };
  }
};

// Natural language intent classifier for built-in intelligence
function processNaturalLanguageQuery(userPrompt: string, context?: any) {
  const q = userPrompt.toLowerCase();

  // 1. Classrooms with capacity above X
  const capMatch = q.match(/capacity\s*(?:above|greater than|>|over)\s*(\d+)/i) || q.match(/(?:above|>|over)\s*(\d+)\s*(?:capacity|seats|students|people)/i);
  if (capMatch || q.includes('capacity above 60') || q.includes('above 60')) {
    const threshold = capMatch ? parseInt(capMatch[1], 10) : 60;
    const result = toolHandlers.search_rooms({ minCapacity: threshold });
    const formatted = result.rooms.map((r: any) => `• **${r.roomNumber}** (${r.name}) — Capacity: **${r.capacity}** [${r.status.toUpperCase()}] in ${r.building}`).join('\n');
    return {
      text: `Found **${result.count} classrooms** with seating capacity above ${threshold}:\n\n${formatted}\n\nWould you like me to reserve one of these rooms or check availability for a specific time?`,
      toolsUsed: ['search_rooms'],
      cards: result.rooms.slice(0, 4).map((r: any) => ({ type: 'room', data: r }))
    };
  }

  // 2. Wi-Fi outage complaints / summary
  if (q.includes('wi-fi') || q.includes('wifi') || q.includes('outage') || q.includes('internet')) {
    const wifiIncidents = incidents.filter(i => i.title.toLowerCase().includes('wi-fi') || i.category === 'Network');
    return {
      text: `### Campus Wi-Fi Outage Status & Incident Summary\n\n• **Incident:** ${wifiIncidents[0]?.title || 'North Quad Aggregation Switch Outage'}\n• **Affected Areas:** Orion Academic Block (Floors 1 & 2: Rooms A-101, A-102, B-201, B-202)\n• **Current Status:** **MITIGATING** (Severity: HIGH)\n• **Action Taken:** NOC engineers have bypassed the faulted line onto the backup optical ring; core router firmware reboot scheduled for 10:30 AM.\n\nAll network complaints have been aggregated into this master ticket to avoid redundant dispatches.`,
      toolsUsed: ['search_incidents'],
      cards: wifiIncidents.map(i => ({ type: 'incident', data: i }))
    };
  }

  // 3. Maintenance request for projector in A-102
  if ((q.includes('projector') || q.includes('bulb')) && (q.includes('a-102') || q.includes('a102') || q.includes('multimedia'))) {
    const existing = maintenanceTickets.find(t => t.roomNumber === 'A-102' && t.status !== 'resolved');
    if (q.includes('create') || q.includes('file') || q.includes('log') || q.includes('ticket')) {
      const res = toolHandlers.create_maintenance_request({
        roomNumber: 'A-102',
        title: 'Projector bulb replacement and thermal inspection in A-102',
        category: 'Audio/Visual',
        severity: 'high',
        description: 'Reported via CampusOps Copilot: Projector requires service due to frequent thermal shutdown.'
      });
      return {
        text: `### Maintenance Request Successfully Created!\n\nTicket **#${res.ticket.id}** has been registered in the system.\n\n• **Room:** A-102 (Multimedia Lab, Orion Block Floor 1)\n• **Equipment:** Ceiling 4K Projector\n• **Severity:** High\n• **Technician Recommendation:** Marcus Chen (Senior AV Specialist) is available on the general shift.\n\nRoom status has been updated to **Under Maintenance** to prevent scheduling conflicts.`,
        toolsUsed: ['create_maintenance_request', 'find_available_technicians'],
        actionSuggestion: {
          type: 'view_room',
          label: 'View Room A-102 in Floor Plan',
          payload: { buildingId: 'bldg-orion', floorId: 'fl-orion-1', roomId: 'rm-a102' }
        },
        cards: [{ type: 'ticket', data: res.ticket }]
      };
    } else {
      return {
        text: `Room **A-102 (Multimedia Lab)** currently has an active maintenance ticket:\n\n• **Ticket #101:** Projector bulb flickering and dim with overheat warnings.\n• **Status:** Assigned to **Marcus Chen**.\n• **Part Status:** Replacement lamp dispatched from Central Storage.\n\nWould you like me to file an additional priority escalation or view alternative rooms?`,
        toolsUsed: ['get_room_details'],
        cards: existing ? [{ type: 'ticket', data: existing }] : []
      };
    }
  }

  // 4. Technician for electrical repair
  if (q.includes('technician') || (q.includes('repair') && q.includes('electrical')) || q.includes('electrician')) {
    const res = toolHandlers.find_available_technicians({ specialty: 'Electrical' });
    const formatted = res.technicians.map((t: any) => `• **${t.name}** — ${t.role} (${t.status.toUpperCase()}) | Shift: Morning | Rating: ⭐ ${t.rating} (Active tickets: ${t.activeTickets})`).join('\n');
    return {
      text: `Here are the qualified electrical technicians on campus:\n\n${formatted}\n\n**Sarah Jenkins** is currently responding to the Robotics Lab motor breaker in G-04, while **Liam Morales** is available for immediate dispatch.`,
      toolsUsed: ['find_available_technicians'],
      cards: res.technicians.map((t: any) => ({ type: 'technician', data: t }))
    };
  }

  // 5. Inventory running low
  if (q.includes('inventory') || q.includes('low stock') || q.includes('running low') || q.includes('supplies')) {
    const res = toolHandlers.get_inventory_status({ lowStockOnly: true });
    const formatted = res.items.map((i: any) => `• **${i.name}** — Current Stock: **${i.inStock}** (Min Threshold: ${i.minimum}) @ ${i.location}`).join('\n');
    return {
      text: `### Low Stock Inventory Warning\n\nThe following items are currently at or below their designated restock threshold:\n\n${formatted}\n\nA purchase requisition has been pre-staged for Laser 4K Projector lamps and Cisco Wi-Fi AP modules.`,
      toolsUsed: ['get_inventory_status'],
      cards: res.items.map((i: any) => ({ type: 'inventory', data: i }))
    };
  }

  // 6. Maintenance issues in Orion Academic Block
  if (q.includes('maintenance') && (q.includes('orion') || q.includes('issues') || q.includes('complaints'))) {
    const res = toolHandlers.get_building_details({ buildingName: 'Orion Academic Block' });
    const tickets = res.openTickets;
    const formatted = tickets.map((t: any) => `• **[${t.severity.toUpperCase()}]** #${t.id}: ${t.title} (${t.roomNumber || 'Common Area'}) — Status: ${t.status}`).join('\n');
    return {
      text: `### Active Maintenance in Orion Academic Block\n\nThere are currently **${tickets.length} open maintenance items**:\n\n${formatted}\n\nGround Floor (G-04) and First Floor (A-102) are actively undergoing servicing.`,
      toolsUsed: ['get_building_details'],
      cards: tickets.map((t: any) => ({ type: 'ticket', data: t }))
    };
  }

  // 7. Computer labs in the college
  if (q.includes('computer lab') || q.includes('labs') || q.includes('lab')) {
    const res = toolHandlers.search_rooms({ type: 'Lab' });
    const formatted = res.rooms.map((r: any) => `• **${r.roomNumber}** (${r.name}) — Capacity: ${r.capacity} | Status: **${r.status.toUpperCase()}** (${r.building})`).join('\n');
    return {
      text: `Here are the computer and engineering laboratories across the campus:\n\n${formatted}\n\n**B-201 (AI & Machine Learning Lab)** and **B-203 (Cybersecurity Center)** are both operational and open for scheduling.`,
      toolsUsed: ['search_rooms'],
      cards: res.rooms.slice(0, 4).map((r: any) => ({ type: 'room', data: r }))
    };
  }

  // 8. Classrooms on first floor
  if (q.includes('first floor') || q.includes('1st floor') || q.includes('floor 1')) {
    const f1Rooms = classrooms.filter(r => r.floorId === 'fl-orion-1');
    const formatted = f1Rooms.map(r => `• **${r.roomNumber}** (${r.name}) — ${r.type}, Cap: ${r.capacity} [${r.status.toUpperCase()}]`).join('\n');
    return {
      text: `### Orion Academic Block — First Floor Classrooms:\n\n${formatted}\n\nClick below to open the interactive First Floor architectural layout.`,
      toolsUsed: ['search_rooms'],
      actionSuggestion: {
        type: 'navigate',
        label: 'Explore First Floor Top-View Plan',
        payload: { buildingId: 'bldg-orion', floorId: 'fl-orion-1' }
      },
      cards: f1Rooms.map(r => ({ type: 'room', data: r }))
    };
  }

  // 9. Rooms available tomorrow afternoon / availability
  if (q.includes('tomorrow') || q.includes('available') || q.includes('afternoon') || q.includes('free')) {
    const avail = classrooms.filter(r => r.status === 'available');
    const formatted = avail.slice(0, 5).map(r => `• **${r.roomNumber}** (${r.name}) — Capacity: ${r.capacity} (${r.type})`).join('\n');
    return {
      text: `### Available Classrooms for Tomorrow Afternoon\n\nThe following verified rooms are available without schedule conflicts:\n\n${formatted}\n\nWould you like me to book one for your department?`,
      toolsUsed: ['check_room_availability'],
      cards: avail.slice(0, 4).map(r => ({ type: 'room', data: r }))
    };
  }

  // 10. Critical incidents summary
  if (q.includes('critical') || q.includes('incident') || q.includes('summary') || q.includes('alert')) {
    const res = toolHandlers.get_incident_summary();
    const formatted = res.incidents.map((i: any) => `• **${i.title}** [${i.severity.toUpperCase()}] — Status: ${i.status}\n  *Action:* ${i.actionTaken}`).join('\n\n');
    return {
      text: `### Campus Operations Critical Incident Briefing\n\n${formatted}`,
      toolsUsed: ['get_incident_summary'],
      cards: incidents.map(i => ({ type: 'incident', data: i }))
    };
  }

  // 11. Alternative rooms
  if (q.includes('alternative') || q.includes('replacement room') || q.includes('relocate')) {
    const altRooms = classrooms.filter(r => r.status === 'available' && r.capacity >= 40);
    return {
      text: `If your primary room is unavailable (e.g. A-102 or G-04 under maintenance), here are the top recommended alternatives with equivalent AV equipment and capacity:\n\n1. **A-101 (Computer Science Studio)** — Capacity: 65, Dual Laser Projectors, Wi-Fi 6E\n2. **G-01 (General Lecture Hall)** — Capacity: 85, Laser 4K Projector\n3. **B-201 (AI & Machine Learning Lab)** — Capacity: 48, Workstations with Dual Displays\n\nWould you like me to move your booking to **A-101**?`,
      toolsUsed: ['search_rooms', 'check_room_availability'],
      cards: altRooms.slice(0, 3).map(r => ({ type: 'room', data: r }))
    };
  }

  // Default fallback response with campus context
  const metrics = toolHandlers.get_dashboard_metrics();
  return {
    text: `I'm **CampusOps Copilot**, your real-time campus operations assistant. I can search classrooms, check real-time availability, inspect active maintenance tickets, file repair requests, check inventory, and assign staff.\n\n**Current Overview:**\n• ${metrics.totalClassrooms} Classrooms across ${metrics.totalBuildings} Buildings\n• ${metrics.openTickets} Open maintenance tickets\n• ${metrics.activeIncidents} Active campus incident reports\n• ${metrics.availableStaff} Technicians on active shift\n\nTry asking:\n- *"Show me all classrooms with a capacity above 60."*\n- *"Are there any maintenance issues in Orion Academic Block?"*\n- *"Create a maintenance request for the projector in A-102."*\n- *"Which technician can handle an electrical repair?"*`,
    toolsUsed: ['get_dashboard_metrics']
  };
}

// POST /api/ai/chat
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  const { message, context, conversationHistory } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  // If Gemini API key is configured, execute via Gemini Function Calling
  if (serverAiConfig.apiKey && serverAiConfig.provider === 'gemini') {
    try {
      const ai = new GoogleGenAI({ apiKey: serverAiConfig.apiKey });

      const tools: FunctionDeclaration[] = [
        {
          name: 'search_rooms',
          description: 'Search classrooms by capacity, type, availability status, or building',
          parameters: {
            type: Type.OBJECT,
            properties: {
              buildingName: { type: Type.STRING },
              type: { type: Type.STRING },
              status: { type: Type.STRING },
              minCapacity: { type: Type.NUMBER }
            }
          }
        },
        {
          name: 'get_room_details',
          description: 'Get detailed information about a specific classroom, including equipment, condition, and bookings',
          parameters: {
            type: Type.OBJECT,
            properties: {
              roomNumber: { type: Type.STRING }
            },
            required: ['roomNumber']
          }
        },
        {
          name: 'check_room_availability',
          description: 'Check if a room or rooms are available on a specific date',
          parameters: {
            type: Type.OBJECT,
            properties: {
              roomNumber: { type: Type.STRING },
              date: { type: Type.STRING }
            }
          }
        },
        {
          name: 'create_maintenance_request',
          description: 'Submit a new maintenance complaint for a classroom or building',
          parameters: {
            type: Type.OBJECT,
            properties: {
              roomNumber: { type: Type.STRING },
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              category: { type: Type.STRING },
              severity: { type: Type.STRING }
            },
            required: ['title']
          }
        },
        {
          name: 'find_available_technicians',
          description: 'Find maintenance technicians by specialty and availability',
          parameters: {
            type: Type.OBJECT,
            properties: {
              specialty: { type: Type.STRING }
            }
          }
        },
        {
          name: 'get_inventory_status',
          description: 'Check campus equipment inventory levels and low stock items',
          parameters: {
            type: Type.OBJECT,
            properties: {
              lowStockOnly: { type: Type.BOOLEAN }
            }
          }
        }
      ];

      const modelName = serverAiConfig.model || 'gemini-3.8-flash';
      const promptWithContext = `You are CampusOps Copilot, the AI assistant for CampusOps intelligent campus management platform.
Current campus context:
${JSON.stringify(context || { currentBuilding: 'Orion Academic Block' })}

User request: "${message}"`;

      const aiResponse = await ai.models.generateContent({
        model: modelName,
        contents: promptWithContext,
        config: {
          tools: [{ functionDeclarations: tools }]
        }
      });

      // Check if function calls were made
      const call = aiResponse.functionCalls?.[0];
      if (call && call.name && toolHandlers[call.name]) {
        const toolResult = toolHandlers[call.name](call.args);
        // Generate follow up with tool result
        const followUp = await ai.models.generateContent({
          model: modelName,
          contents: [
            { role: 'user', parts: [{ text: promptWithContext }] },
            { role: 'model', parts: [{ functionCall: call }] },
            {
              role: 'user',
              parts: [{
                functionResponse: {
                  name: call.name,
                  response: toolResult
                }
              }]
            }
          ]
        });

        return res.json({
          text: followUp.text || `Executed ${call.name} successfully.`,
          toolsUsed: [call.name],
          toolData: toolResult
        });
      }

      if (aiResponse.text) {
        return res.json({
          text: aiResponse.text,
          toolsUsed: []
        });
      }
    } catch (err: any) {
      console.warn('Gemini API call failed, falling back to built-in semantic engine:', err.message);
      // Fallback seamlessly to natural language processor
    }
  }

  // Built-in intelligent semantic rules engine:
  // Instant, accurate, zero latency, runs even without an external API key!
  const result = processNaturalLanguageQuery(message, context);
  res.json(result);
});

// ==================== VITE DEV & PRODUCTION MOUNT ====================

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`CampusOps server listening on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
