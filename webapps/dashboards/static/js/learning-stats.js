/**
 * Script for rendering learning efficiency and retention (TODO(david)) from
 * exercises dashboard.
 */


(function() {


// TODO(david): Shared data fetcher.
var BASE_STAT_SERVER_URL = "http://184.73.72.110:27080/";
var BASE_COLLLECTION_URL = BASE_STAT_SERVER_URL +
    "report/weekly_learning_stats/";


/**
 * A single data series to show on a chart.
 */
var Series = Backbone.Model.extend({

    defaults: {
        results: [],
        numCalls: 0,
        batchSize: 1000,
        requestCount: 0
    },

    /**
     * Reset to prepare for a new chain of batch calls.
     */
    reset: function() {
        this.set("results", []);
        this.set("numCalls", 0);
    },

    /**
     * Get a single batch of data from the server, and get more if necessary.
     */
    fetchResults: function(url, params) {

        var self = this;
        this.set("requestCount", this.get("requestCount") + 1);

        // TODO(david) FIXME: Another series could send off a request with the
        //     same cursor ID, since unfortunately Sleepy Mongoose does not have
        //     a stateless RESTful API (it's not a cursor ID, it's an ID of the
        //     query:
        //     github.com/kchodorow/sleepy.mongoose/wiki/Getting-More-Results ).
        //     This leads to _more responses with the same ID being interleaved
        //     among both senders.
        AjaxCache.getJson(url, params, _.bind(function(requestCount, data) {

            // A new batch request has been initiated, abort this one
            if (requestCount !== self.get("requestCount")) {
                return;
            }

            var dataResults = data["results"];
            if (dataResults && dataResults.length) {

                // Update with new data
                var results = self.get("results");
                results = results.concat(dataResults);
                results = groupByCardNumber(results);
                self.set("results", results);

            }

            if (dataResults && dataResults.length === self.get("batchSize")) {

                // There's probably more; fetch another batch of results
                var moreUrl = BASE_COLLLECTION_URL + "_more?callback=?";
                var moreParams = {
                    batch_size: self.get("batchSize"),
                    id: data["id"],
                    callNum_: self.get("numCalls")
                };
                self.fetchResults(moreUrl, moreParams);

            } else {

                self.trigger("allResultsLoaded");

            }

            self.set("numCalls", self.get("numCalls") + 1);

        }, null, this.get("requestCount")));

    }

});


/**
 * View of a data series.
 * TODO(david): Change IDs to classes to support multiple series views.
 */
var SeriesView = Backbone.View.extend({

    template: Handlebars.compile($("#series-form-template").text()),

    // TODO(david): Do interesting things on hover over a series form.
    events: {
        "change .stacks-select": "refresh",
        "change .topics-select": "refresh"
    },

    initialize: function(options) {

        this.chartSeries = options.chartSeries;

        this.model
            .bind("change:results", this.updateSeries, this)
            .bind("change:numCalls", this.updateProgress, this)
            .bind("allResultsLoaded", function() {
                this.$el.find(".request-pending-progress").hide();
            }, this);

    },

    render: function() {
        this.$el.html(this.template({
            seriesName: this.chartSeries.name,
            stacksOptions: _.range(1, 21)
        }));

        // TODO(david): Color form background with series
        this.$el.find('h2').css('color', this.chartSeries.color);

        this.populateTopics();

        return this;
    },

    /**
     * Get topic IDs to generate learning curves for and populate select box.
     */
    populateTopics: function() {
        var self = this;
        // TODO(david): Filter out pseudo-topic "any"
        AjaxCache.getJson("/db/learning_stats_topics", {}, function(data) {
            var options = _.map(data["topics"], function(topic) {
                return $("<option>").text(topic)[0];
            });
            self.$el.find(".topics-select").append(options);
        });
    },

    /**
     * Ask the server for new data from user-set controls on the dashboard.
     */
    refresh: function() {

        this.$el.find(".request-pending-progress").show();

        var numStacks = this.$el.find(".stacks-select").val();
        var topic = this.$el.find(".topics-select option:selected").val();

        // TODO(david): More permanent database, and design summary table with
        //     date partitions.
        var url = BASE_COLLLECTION_URL + "_find?callback=?";

        // TODO(david): Batch up requests
        var criteria = {
            num_problems_done: numStacks === "any" ? { $lte: 160 } :
                numStacks * 8,
            topic: topic,
            start_dt: '2012-06-13'  // TODO(david): Support date range selection
        };

        var params = {
            criteria: JSON.stringify(criteria),
            batch_size: this.model.get("batchSize"),
            fields: JSON.stringify({
                card_number: true,
                num_deltas: true,
                sum_deltas: true
            })
        };

        this.model.reset();
        this.model.fetchResults(url, params);

    },

    updateProgress: function() {
        var fakedProgress = 1 - Math.pow(0.66, this.model.get("numCalls"));
        fakedProgress = Math.max(0.1, fakedProgress);
        this.$el.find(".request-pending-progress .bar")
                .css("width", fakedProgress.toFixed(2) * 100 + "%");
    },

    /**
     * Update UI elements that show data series info, such as the graph and
     * sample counter.
     */
    updateSeries: function() {

        var results = this.model.get("results");

        var incrementalGains = _.chain(results)
            .groupByCardNumber()
            .sortBy(function(row) { return +row["card_number"]; })
            .map(function(row, index) {
                return row["sum_deltas"] / row["num_deltas"];
            })
            .value();

        var accumulatedGains = _.reduce(incrementalGains,
                function(accum, delta) {
            return accum.concat([_.last(accum) + delta]);
        }, [0]);

        this.chartSeries.setData(accumulatedGains);
        // TODO(david): Restore displaying of incremental gains

        // TODO(david): Show # of distinct users and error bounds
        var totalDeltas = _.reduce(results, function(accum, row) {
            return accum + +row["num_deltas"];
        }, 0);
        this.$el.find(".total-deltas").text(totalDeltas);

    }

});


/**
 * Chart of learning efficiency, as measured by incremental accuracy deltas.
 */
var EfficiencyChartView = Backbone.View.extend({

    // TODO(david): This will be changed once more chart types are added.
    el: "body",

    events: {
        "click #compare-button": "addSeries"
    },

    initialize: function() {
        this.chart = this.createChart();
        this.addSeries();
    },

    /**
     * Create learning curve HighCharts graph.
     * @return {HighCharts.Chart}
     */
    createChart: function() {
        // TODO(david): Dynamically generate labels and titles
        var chartOptions = {
            chart: {
                renderTo: "efficiency-chart"
            },
            series: [],
            title: {
                text: "Accumulated gain in accuracy over number of cards done"
            },
            yAxis: {
                title: { text: "Accumulated gain in accuracy" },
            },
            xAxis: {
                title: { text: "Card Number" },
                min: 0,
                max: 100
            },
            credits: { enabled: false }
        };

        var chart = new Highcharts.Chart(chartOptions);

        return chart;
    },

    addSeries: function() {

        var seriesNum = ++EfficiencyChartView.numSeries;
        var chartSeries = this.chart.addSeries({
            data: [],
            type: "areaspline",
            name: "Series " + seriesNum,
            // TODO(david): Bootstrap from 1st card % correct?
            pointStart: 0
        });

        var series = new Series();
        var seriesView = new SeriesView({
            el: $("<div>").appendTo("#series-forms"),
            model: series,
            chartSeries: chartSeries
        });
        seriesView.render().refresh();

    }

}, {

    numSeries: 0

});


/**
 * Aggregate rows by card number. Idempotent. This is not done through Sleepy
 * Mongoose because it may be buggy: https://jira.mongodb.org/browse/SERVER-5874
 * @param {Array.<Object>} results Rows from Mongo collection.
 * @return {Array.<Object>} Rows aggregated by card number.
 */
var groupByCardNumber = function groupByCardNumber(results) {
    return _.chain(results)
        .groupBy(function(row) { return row["card_number"]; })
        .map(function(group, cardNumber) {

            return _.chain(group)
                .reduce(function(accum, row) {
                    return {
                        sum_deltas: +accum["sum_deltas"] + +row["sum_deltas"],
                        num_deltas: +accum["num_deltas"] + +row["num_deltas"]
                    };
                })
                .extend({ card_number: cardNumber })
                .value();

        })
        .toArray()
        .value();
};


// Add utility functions to underscore for convenience in chaining
_.mixin({
    groupByCardNumber: groupByCardNumber
});


$(function() {
    var dashboard = new EfficiencyChartView();
});


})();