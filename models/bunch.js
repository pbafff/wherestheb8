var mongoose = require('mongoose')
    , Schema = mongoose.Schema;

var bunchSchema = new Schema({
    bunch_id: String, //Generated by direction and incrementing value
    begin: Date,
    end: Date,
    buses: [{ type: Schema.Types.ObjectId, ref: 'Trip' }],
    locations: [{ time: Date, coordinates: [] }],
    traffic: [{ time: Date, speed: Number }]
});

module.exports = mongoose.model('Bunch', bunchSchema);