const API_URL = "https://api.openstreetmap.org"

let presets = null;
async function getPresets() {
	if (presets) return presets;
	const res = await fetch("./presets.json");
	presets = await res.json();
	return presets;
}

let field_names = null;
async function getFieldNames() {
	if (field_names) return field_names;
	const res = await fetch("./en_field_names.json");
	field_names = await res.json();
	return field_names;
}

function initFormData(data) {
	data.date_range_values = [
		["-7days", "Last 7 days"],
		["-24hours", "Last 24 hours"],
		["-6weeks", "Last 6 weeks"],
	];

	//const now = new Date();
	//const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	//data.date_range_values.push(["this_month", `This month (${months[now.getMonth()]})`])
	//var last_month = new Date(now);
	//last_month.setMonth(now.getMonth()-1);
	//data.date_range_values.push(["last_month", `Last month (${months[last_month.getMonth()]})`])
}

async function generate_stats(data) {
	parse_out_dates(data);
	if (!data.is_valid) {
		return;
	}

	document.getElementById("output").innerHTML = "";

	await fetch_user_data(data);

	var [tagged_object_changes, tag_changes] = calcTagChanges(data.from_datetime, data.to_datetime);
	var obj_pre_post = calcObjectPrePost(data.from_datetime, data.to_datetime);
	if (obj_pre_post.length == 0) {
		document.getElementById("output").innerHTML = "No Edits in this time! Get Mapping!";
	} else {

		document.getElementById("output").innerHTML = await calcTagChangeTable(tag_changes);
		//document.getElementById("output").innerHTML = calcChangeTagsIDPresets(obj_pre_post);
		//
	}
}

function parse_out_dates(data) {
	data.is_valid = true;
	if (data.date_range == "custom") {
		var one_invalid = false;
		if (data.from_datetime == "") {
			var el = document.getElementById("from_datetime");
			el.setCustomValidity("Missing input");
			el.reportValidity();
			one_invalid = true;
		} else {
			document.getElementById("from_datetime").setCustomValidity("");
		}
		if (data.to_datetime == "") {
			var el = document.getElementById("to_datetime");
			el.setCustomValidity("Missing input");
			el.reportValidity();
			one_invalid = true;
		} else {
			document.getElementById("to_datetime").setCustomValidity("");
		}
		if (one_invalid) {
			data.is_valid = false;
			return;
		}
	} else {
		var relative_range = data.date_range.match(/-(\d+)(days|hours|weeks)/);
		var exact_range = data.date_range.match(/(20\d\d-\d\d-\d\d.+)\.\.(20\d\d-\d\d-\d\d.+)/);
		if (relative_range) {
			data.to_datetime = new Date().toISOString();
			var mult = {"hours": 3600*1000, "days": 24*3600*1000, "weeks": 7*24*3600*1000 }[relative_range[2]]
			var secs = parseInt(relative_range[1], 10) * mult;
			data.from_datetime = new Date(new Date() - secs).toISOString();
		} else if (exact_range) {
			data.from_datetime = new Date(exact_range[1]).toISOString();
			data.to_datetime = new Date(exact_range[2]).toISOString();
		} else {
			console.error(`Unknown date range ${data.date_range}`);
		}
	}
}

async function clear_local_cache() {
	localStorage.removeItem("cached_data");
}

async function fetch_user_data(data) {
	data.is_calculating = true;

	var cached_data_raw = localStorage.getItem("cached_data");
	if (cached_data_raw === null) {
		cached_data = {
			"user_changesets": {},
			"changeset_full": {},
			"objects": {"node": {}, "way": {}, "relation": {} },
		};
	} else {
		var cached_data = JSON.parse(cached_data_raw);
	}
	const now = new Date().toISOString();

	var uid = "23770";
	var task_list = [];


	task_list.push(["dl_user_changesets", uid, data.from_datetime, data.to_datetime]);

	const progress_bar = document.getElementById("task_process");
	progress_bar.max = 0;
	progress_bar.value = 0;

	while (task_list.length > 0) {
		var task = task_list.shift();
		progress_bar.value++;
		switch (task[0]) {
			case "dl_user_changesets":
				var uid = task[1]
				var from_datetime = task[2];
				var to_datetime = task[3];

				var res = await fetch(`${API_URL}/api/0.6/changesets.json?user=${uid}&time=${from_datetime},${to_datetime}`);
				var json_res = await res.json();
				cached_data.user_changesets[uid] = json_res;
				var changesets = json_res.changesets;
				
				if (changesets.length >= 100) {
					// possibly more changesets
					var latest_timestamp = changesets.reduce((max, item) => (item.created_at > max ? item.created_at : max), changesets[0].created_at);
					task_list.push(["dl_user_changesets", uid, latest_timestamp, data.to_datetime]);
				}

				for (let c of changesets) {
					task_list.push(["dl_changeset", c]);
					progress_bar.max++;
				}
				break;
			case "dl_changeset":
				var changeset_obj = task[1];
				if (!(changeset_obj.id in cached_data.changeset_full) || (now > cached_data.changeset_full[changeset_obj.id].expire)) {
					var res = await fetch(`${API_URL}/api/0.6/changeset/${changeset_obj.id}/download`);
					var xml_src = await res.text();
					var jsonified = parseOsmChange(xml_src);
					var expire;
					if (changeset_obj.open) {
						var expire = new Date(Date.now() + 60*1000).toISOString();
					} else {
						expire = "2050-01-01T00:00:00Z";
					}
					cached_data.changeset_full[changeset_obj.id] ={'expire': expire, 'json': jsonified};
				}
				var changeset_full = cached_data.changeset_full[changeset_obj.id].json;
				for (const action of ["create", "modify", "delete"]) {
					for (const obj of changeset_full[action]) {
						setdefault(cached_data.objects[obj.type], obj.id, {});
						cached_data.objects[obj.type][obj.id][obj.version] = obj;
					}
				}
				for (const obj of changeset_full["modify"]) {
					task_list.push(["dl_prev_vers", obj]);
					progress_bar.max++;
				}
				break;
			case "dl_prev_vers":
				var obj = task[1];
				var prev_version = calcPrevVersion(obj);
				if (!(prev_version in cached_data.objects[obj.type][obj.id])) {
					var res = await fetch(`${API_URL}/api/0.6/${obj.type}/${obj.id}/${prev_version}.json`);
					var jsonified = await res.json();
					var new_obj = jsonified.elements[0];
					cached_data.objects[new_obj.type][new_obj.id][new_obj.version] = new_obj;
				}

				break;
			default:
				console.error("Unknown task", task[0]);
				break;
		}
	}
	progress_bar.value = progress_bar.max;

	localStorage.setItem("cached_data", JSON.stringify(cached_data));
	data.is_calculating = false;
}


function parseOsmChange(xmlString) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlString, "text/xml");

  const result = {"create": [], "modify": [], "delete": []};

  const actions = ["create", "modify", "delete"];

  for (const action of actions) {
	  for (const actionNode of xml.querySelectorAll(action)) {
		  for (const el of actionNode.children) {
			  const obj = {
				  type: el.tagName
			  };

			  // copy attributes
			  for (const attr of ["timestamp", "user"]) {
				  obj[attr] = el.attributes[attr].value;
			  }
			  if (el.tagName == "node") {
				  obj["lat"] = Number(el.attributes["lat"]?.value ?? null);
				  obj["lon"] = Number(el.attributes["lon"]?.value ?? null);
			  }
			  for (const attr of ["uid", "id", "changeset", "version"]) {
				  obj[attr] = Number(el.attributes[attr].value);
			  }
			  obj["visible"] = el.attributes["visible"] == "true";

			  // collect tags into key-value object
			  obj.tags = {}
			  for (const tag of el.querySelectorAll("tag")) {
				  const k = tag.getAttribute("k");
				  const v = tag.getAttribute("v");
				  obj.tags[k] = v;
			  }

			  // TODO: Nodes for ways
			  // TODO: members for relations


			  result[action].push(obj);
		  }
	  }
  }

  return result;
}

function setdefault(obj, key, defaultValue) {
	if (!(key in obj)) {
		obj[key] = defaultValue
	}
}
function calcPrevVersion(obj) {
	return String(Number(obj.version) - 1);
}
function assert(condition, message = "Assertion failed") {
  if (!condition) {
    throw new Error(message);
  }
}
function assertNonNull(val, message = "Assertion of Non-null failed") {
	assertNe(val, null, message);
}
function assertNe(val, ne, message = "Assertion failed") {
  if (val == ne) {
    throw new Error(message);
  }
}

function calcObjectPrePost(from_datetime, to_datetime) {
	var cached_data = JSON.parse(localStorage.getItem("cached_data"));
	assertNonNull(cached_data);

	var res = [];

	for (const expire_changeset of Object.values(cached_data.changeset_full)) {
		const changeset = expire_changeset.json;
		for (const new_obj of changeset.create) {
			if (new_obj.timestamp <= from_datetime || new_obj.timestamp >= to_datetime) {
				continue;
			}
			res.push([null, new_obj]);
		}
		for (const new_obj of changeset.modify) {
			if (new_obj.timestamp <= from_datetime || new_obj.timestamp >= to_datetime) {
				continue;
			}
			old_obj = cached_data.objects[new_obj.type][new_obj.id][calcPrevVersion(new_obj)];
			res.push([old_obj, new_obj]);
		}

		for (const old_obj of changeset.delete) {
			if (old_obj.timestamp <= from_datetime || old_obj.timestamp >= to_datetime) {
				continue;
			}
			res.push([old_obj, null]);
		}
	}
	
	return res;
}

function calcTagChanges(from_datetime, to_datetime) {
	var cached_data = JSON.parse(localStorage.getItem("cached_data"));
	assertNonNull(cached_data);

	var tag_changes = {};
	var tagged_object_changes = {'create': 0, 'modify': 0, 'delete':0 };

	for (const expire_changeset of Object.values(cached_data.changeset_full)) {
		const changeset = expire_changeset.json;
		for (const new_obj of changeset.create) {
			if (new_obj.timestamp <= from_datetime || new_obj.timestamp >= to_datetime) {
				continue;
			}
			for (const k of Object.keys(new_obj.tags)) {
				setdefault(tag_changes, k, {'create':0, 'modify':0, 'delete':0});
				tag_changes[k].create++;
			}
			if (Object.keys(new_obj.tags).length > 0) {
				tagged_object_changes.create++;
			}
		}
		for (const new_obj of changeset.modify) {
			if (new_obj.timestamp <= from_datetime || new_obj.timestamp >= to_datetime) {
				continue;
			}
			old_obj = cached_data.objects[new_obj.type][new_obj.id][calcPrevVersion(new_obj)];
			for (const k of Object.keys(old_obj.tags)) {
				if (!(k in new_obj.tags)) {
					setdefault(tag_changes, k, {'create':0, 'modify':0, 'delete':0});
					tag_changes[k].delete++;
				}
			}

			for (const k of Object.keys(new_obj.tags)) {
				if (!(k in old_obj.tags)) {
					setdefault(tag_changes, k, {'create':0, 'modify':0, 'delete':0});
					tag_changes[k].create++;
				}
				if ((k in old_obj.tags) && (k in new_obj.tags) && (old_obj.tags[k] != new_obj.tags[k])) {
					setdefault(tag_changes, k, {'create':0, 'modify':0, 'delete':0});
					tag_changes[k].modify++;
				}
			}

			if (Object.keys(old_obj.tags).length > 0 || Object.keys(new_obj.tags).length > 0) {
				tagged_object_changes.modify++;
			}

		}

		for (const old_obj of changeset.delete) {
			if (old_obj.timestamp <= from_datetime || old_obj.timestamp >= to_datetime) {
				continue;
			}
			if (Object.keys(old_obj.tags).length > 0) {
				tagged_object_changes.delete++;
			}
			for (const k of Object.keys(old_obj.tags)) {
				setdefault(tag_changes, k, {'create':0, 'modify':0, 'delete':0});
				tag_changes[k].delete++;
			}
		}

	}

	return [tagged_object_changes, tag_changes];
}

function getDaysBetween(start, end) {
	const days = [];

	// clone so we don't mutate inputs
	const current = new Date(start);

	// normalize time to midnight (important)
	current.setHours(0, 0, 0, 0);
	const endDate = new Date(end);
	endDate.setHours(0, 0, 0, 0);

	while (current <= endDate) {
		days.push(new Date(current)); // copy
		current.setDate(current.getDate() + 1);
	}

	return days;
}

async function calcTagChangeTable(tag_changes) {
	var res = []
	for (const k of Object.keys(tag_changes)) {
		res.push([tag_changes[k].create+tag_changes[k].modify+tag_changes[k].delete, k]);
	}

	res.sort((a, b) => (b[0]-a[0]));
	var res = res.slice(0, 100);

	const field_names = await getFieldNames();

	var summary = "<table><tr><th>Tag</th><th>Total</th><th>Added</th><th>Modified</th><th>Deleted</th><tr>";

	for (const [total, k] of res) {
		var field_text = field_names[k] ?? `<code>${k}</code>`;

		summary += `<tr><td>${field_text}</td><td>${total}</td><td>${tag_changes[k].create}</td><td>${tag_changes[k].modify}</td><td>${tag_changes[k].delete}</td></tr>`;
	}

	summary += "</table>";

	return summary;
}

function calcChangeTagsIDPresets(obj_pre_post) {
	console.log(obj_pre_post);
}

